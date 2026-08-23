import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { privateKeyToAccount } from "viem/accounts";
import type { CandidateStore, DropStatusStore, PreparedTransactionStore } from "../domain/ports";
import type { Address, DropStatus, MintCandidate, PreparedTransaction } from "../domain/types";
import type { RegisteredUser, UserRegistry } from "../users/registry";
import type { UserKeyStore } from "../users/keystore";
import type { AutoMintAttempt, AutoMintLog } from "../execution/automint";
import type { BlockCursorStore } from "../discovery/rpc/block-cursor";
import { CONTRACT_REGISTRY_CAP, type ContractRegistry } from "../discovery/rpc/contract-registry";
import { decryptSecret, encryptSecret } from "../users/crypto";

/**
 * All persistence adapters for running Orbis on a host with no reliable local filesystem
 * (a Render service's disk isn't guaranteed to survive a restart or redeploy) instead of
 * the JSONL stores used by scripts/telegram-bot.ts. Every class here implements the same
 * port/interface as its Jsonl counterpart, so engine and bot code are unchanged — only the
 * wiring at the entrypoint differs. Callers must pass a client built with the Supabase
 * **service role** key (never the publishable/anon key): these tables have RLS enabled
 * with no policies, i.e. default-deny for anything else.
 */
export function createSupabaseClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

export class SupabaseCandidateStore implements CandidateStore {
  constructor(private readonly db: SupabaseClient) {}

  async save(candidate: MintCandidate): Promise<void> {
    const { id, valueWei, ...rest } = candidate;
    const { error } = await this.db
      .from("candidates")
      .upsert({ id, data: { ...rest, valueWei: valueWei.toString() }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Supabase candidates upsert failed: ${error.message}`);
  }

  async list(): Promise<MintCandidate[]> {
    const { data, error } = await this.db.from("candidates").select("id, data");
    if (error) throw new Error(`Supabase candidates list failed: ${error.message}`);
    return (data ?? []).map((row) => {
      const raw = row.data as Omit<MintCandidate, "valueWei" | "id"> & { valueWei: string };
      return { ...raw, id: row.id as string, valueWei: BigInt(raw.valueWei) };
    });
  }
}

export class SupabasePreparedTransactionStore implements PreparedTransactionStore {
  constructor(private readonly db: SupabaseClient) {}

  async save(tx: PreparedTransaction): Promise<void> {
    const { error } = await this.db.from("prepared_transactions").upsert(
      {
        chain_key: tx.chainKey,
        chain_id: tx.chainId,
        to_address: tx.to,
        data: tx.data,
        value: tx.value.toString(),
        from_address: tx.from ?? null,
        gas: tx.gas.toString(),
        gas_price_wei: tx.gasPriceWei.toString(),
        simulation_mode: tx.simulationMode,
        policy: tx.policy,
        reasons: tx.reasons,
        prepared_at: tx.preparedAt,
        candidate_id: tx.candidateId ?? null,
        mint_function: tx.mintFunction ?? null,
        abi: tx.abi ?? null,
      },
      { onConflict: "chain_id,to_address,data" },
    );
    if (error) throw new Error(`Supabase prepared_transactions upsert failed: ${error.message}`);
  }

  async list(): Promise<PreparedTransaction[]> {
    const { data, error } = await this.db.from("prepared_transactions").select("*").order("id", { ascending: true });
    if (error) throw new Error(`Supabase prepared_transactions list failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      chainKey: row.chain_key,
      chainId: row.chain_id,
      to: row.to_address,
      data: row.data,
      value: BigInt(row.value),
      from: row.from_address ?? undefined,
      gas: BigInt(row.gas),
      gasPriceWei: BigInt(row.gas_price_wei),
      simulationMode: row.simulation_mode,
      policy: row.policy,
      reasons: row.reasons ?? [],
      preparedAt: row.prepared_at,
      candidateId: row.candidate_id ?? undefined,
      mintFunction: row.mint_function ?? undefined,
      abi: row.abi ?? undefined,
    }));
  }
}

export class SupabaseUserRegistry implements UserRegistry {
  constructor(private readonly db: SupabaseClient) {}

  async register(userId: string, address: Address): Promise<RegisteredUser> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`Invalid address: ${address}`);
    const registeredAt = new Date().toISOString();
    const { error } = await this.db.from("users").upsert({ user_id: userId, address, registered_at: registeredAt });
    if (error) throw new Error(`Supabase users upsert failed: ${error.message}`);
    return { userId, address, registeredAt };
  }

  async addressFor(userId: string): Promise<Address | undefined> {
    const { data, error } = await this.db.from("users").select("address").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`Supabase users lookup failed: ${error.message}`);
    return (data?.address as Address | undefined) ?? undefined;
  }

  async list(): Promise<RegisteredUser[]> {
    const { data, error } = await this.db.from("users").select("user_id, address, registered_at");
    if (error) throw new Error(`Supabase users list failed: ${error.message}`);
    return (data ?? []).map((row) => ({ userId: row.user_id, address: row.address as Address, registeredAt: row.registered_at }));
  }
}

type KeyRow = { user_id: string; address: string; enc_iv: string; enc_data: string; auto_mint_enabled: boolean; removed: boolean };

export class SupabaseUserKeyStore implements UserKeyStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly encryptionKey: Uint8Array,
  ) {}

  private async row(userId: string): Promise<KeyRow | undefined> {
    const { data, error } = await this.db.from("automint_keys").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`Supabase automint_keys lookup failed: ${error.message}`);
    return (data as KeyRow | null) ?? undefined;
  }

  private active(row: KeyRow | undefined): KeyRow | undefined {
    return row && !row.removed ? row : undefined;
  }

  async setKey(userId: string, privateKey: `0x${string}`): Promise<Address> {
    const address = privateKeyToAccount(privateKey).address;
    const enc = await encryptSecret(privateKey, this.encryptionKey);
    const { error } = await this.db.from("automint_keys").upsert({
      user_id: userId,
      address,
      enc_iv: enc.iv,
      enc_data: enc.data,
      auto_mint_enabled: false,
      removed: false,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Supabase automint_keys upsert failed: ${error.message}`);
    return address;
  }

  async hasKey(userId: string): Promise<boolean> {
    return this.active(await this.row(userId)) !== undefined;
  }

  async addressFor(userId: string): Promise<Address | undefined> {
    return this.active(await this.row(userId))?.address as Address | undefined;
  }

  async getDecryptedKey(userId: string): Promise<`0x${string}` | undefined> {
    const record = this.active(await this.row(userId));
    if (!record) return undefined;
    return (await decryptSecret({ iv: record.enc_iv, data: record.enc_data }, this.encryptionKey)) as `0x${string}`;
  }

  async setAutoMint(userId: string, enabled: boolean): Promise<void> {
    const record = this.active(await this.row(userId));
    if (!record) throw new Error("No burner wallet registered. Use /autokey <privatekey> first.");
    const { error } = await this.db
      .from("automint_keys")
      .update({ auto_mint_enabled: enabled, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw new Error(`Supabase automint_keys update failed: ${error.message}`);
  }

  async isAutoMintEnabled(userId: string): Promise<boolean> {
    return this.active(await this.row(userId))?.auto_mint_enabled === true;
  }

  async removeKey(userId: string): Promise<void> {
    const { error } = await this.db
      .from("automint_keys")
      .update({ removed: true, auto_mint_enabled: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw new Error(`Supabase automint_keys update failed: ${error.message}`);
  }

  async listEnabled(): Promise<{ userId: string; address: Address }[]> {
    const { data, error } = await this.db.from("automint_keys").select("user_id, address").eq("auto_mint_enabled", true).eq("removed", false);
    if (error) throw new Error(`Supabase automint_keys list failed: ${error.message}`);
    return (data ?? []).map((row) => ({ userId: row.user_id, address: row.address as Address }));
  }
}

export class SupabaseAutoMintLog implements AutoMintLog {
  constructor(private readonly db: SupabaseClient) {}

  async hasAttempt(userId: string, key: string): Promise<boolean> {
    const { data, error } = await this.db.from("automint_log").select("id").eq("user_id", userId).eq("tx_key", key).maybeSingle();
    if (error) throw new Error(`Supabase automint_log lookup failed: ${error.message}`);
    return data !== null;
  }

  async record(attempt: AutoMintAttempt): Promise<void> {
    // ignoreDuplicates preserves "attempted at most once": a race between two
    // invocations recording the same (user, opportunity) pair keeps the first row.
    const { error } = await this.db.from("automint_log").upsert(
      { user_id: attempt.userId, tx_key: attempt.txKey, status: attempt.status, tx_hash: attempt.txHash ?? null, error: attempt.error ?? null, at: attempt.at },
      { onConflict: "user_id,tx_key", ignoreDuplicates: true },
    );
    if (error) throw new Error(`Supabase automint_log insert failed: ${error.message}`);
  }
}

/** Live-execution guard, backed by the generic kv_state table. Fetch once per invocation and reuse the {get,set} pair — see AutoMintLoop / TelegramCommandBot deps. */
export async function loadGuardState(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from("kv_state").select("value").eq("key", "guard").maybeSingle();
  if (error) throw new Error(`Supabase kv_state lookup failed: ${error.message}`);
  return (data?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

export async function saveGuardState(db: SupabaseClient, enabled: boolean): Promise<void> {
  const { error } = await db.from("kv_state").upsert({ key: "guard", value: { enabled }, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase kv_state upsert failed: ${error.message}`);
}

/** Per-chain last-scanned-block cursor for BlockContractDiscoverySource, backed by the same generic kv_state table as the guard flag. */
export class SupabaseBlockCursorStore implements BlockCursorStore {
  constructor(private readonly db: SupabaseClient) {}

  async get(chainKey: string): Promise<bigint | undefined> {
    const { data, error } = await this.db.from("kv_state").select("value").eq("key", `block_cursor:${chainKey}`).maybeSingle();
    if (error) throw new Error(`Supabase kv_state lookup failed: ${error.message}`);
    const value = data?.value as { block?: string } | undefined;
    return value?.block !== undefined ? BigInt(value.block) : undefined;
  }

  async set(chainKey: string, block: bigint): Promise<void> {
    const { error } = await this.db.from("kv_state").upsert({ key: `block_cursor:${chainKey}`, value: { block: block.toString() }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Supabase kv_state upsert failed: ${error.message}`);
  }
}

/** Per-key set of previously-seen contracts (e.g. SeaDrop collections), backed by the same generic kv_state table. See ContractRegistry's doc comment for why this exists. */
export class SupabaseContractRegistry implements ContractRegistry {
  constructor(private readonly db: SupabaseClient) {}

  async list(key: string): Promise<Address[]> {
    const { data, error } = await this.db.from("kv_state").select("value").eq("key", `contract_registry:${key}`).maybeSingle();
    if (error) throw new Error(`Supabase kv_state lookup failed: ${error.message}`);
    return ((data?.value as { contracts?: Address[] } | undefined)?.contracts ?? []);
  }

  async add(key: string, contract: Address): Promise<void> {
    const existing = await this.list(key);
    if (existing.includes(contract)) return;
    const contracts = [...existing, contract].slice(-CONTRACT_REGISTRY_CAP);
    const { error } = await this.db.from("kv_state").upsert({ key: `contract_registry:${key}`, value: { contracts }, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Supabase kv_state upsert failed: ${error.message}`);
  }
}

/** Latest known status per drop (live free/paid, upcoming, ended), one kv_state row per drop. See DropStatus's doc comment for why this exists. */
export class SupabaseDropStatusStore implements DropStatusStore {
  constructor(private readonly db: SupabaseClient) {}

  async save(status: DropStatus): Promise<void> {
    const { error } = await this.db.from("kv_state").upsert({ key: `drop_status:${status.id}`, value: status, updated_at: new Date().toISOString() });
    if (error) throw new Error(`Supabase kv_state upsert failed: ${error.message}`);
  }

  async list(): Promise<DropStatus[]> {
    const { data, error } = await this.db.from("kv_state").select("value").like("key", "drop_status:%");
    if (error) throw new Error(`Supabase kv_state list failed: ${error.message}`);
    return (data ?? []).map((row) => row.value as DropStatus);
  }
}
