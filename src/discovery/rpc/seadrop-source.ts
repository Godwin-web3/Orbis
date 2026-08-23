import { createPublicClient, http, encodeFunctionData, parseAbiItem, type Abi, type Address, type PublicClient } from "viem";
import type { DiscoverySource, DropStatusStore } from "../../domain/ports";
import type { DropStatus, MintCandidate } from "../../domain/types";
import type { BlockCursorStore } from "./block-cursor";
import type { ContractRegistry } from "./contract-registry";
import { fetchLogsViaEtherscan } from "./etherscan-logs";

// OpenSea's SeaDrop singleton — identical address across Ethereum, Base, and Robinhood
// Chain (cross-verified against two independent third-party mint tools that hardcode
// this same address, and directly against real on-chain data: 11 live mint events
// observed in a single ~50 block window on Ethereum mainnet).
export const SEADROP_ADDRESS: Address = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPENSEA_FEE_RECIPIENT: Address = "0x0000a26b00c1F0DF003000390027140000fAa719";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// ISeaDrop.SeaDropMint — verified by hashing the candidate signature and matching it
// byte-for-byte against the real topic0 observed via eth_getLogs against SEADROP_ADDRESS
// on Ethereum mainnet. nftContract is indexed first, so it lands at topics[1].
const SEADROP_MINT_TOPIC0 = "0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6" as `0x${string}`;
const SEADROP_MINT_EVENT = parseAbiItem(
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)"
);

function topicToAddress(topic: `0x${string}`): Address {
  return `0x${topic.slice(-40)}` as Address;
}

const SEADROP_ABI = [
  {
    type: "function", name: "getPublicDrop", stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "mintPrice", type: "uint80" },
        { name: "startTime", type: "uint48" },
        { name: "endTime", type: "uint48" },
        { name: "maxTotalMintableByWallet", type: "uint16" },
        { name: "feeBps", type: "uint16" },
        { name: "restrictFeeRecipients", type: "bool" },
      ],
    }],
  },
  { type: "function", name: "getAllowedFeeRecipients", stateMutability: "view", inputs: [{ name: "nftContract", type: "address" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "mintPublic", stateMutability: "payable", inputs: [{ name: "nftContract", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "minterIfNotPayer", type: "address" }, { name: "quantity", type: "uint256" }], outputs: [] },
] as const satisfies Abi;

const MAX_BLOCK_RANGE = 50n;
const ETHERSCAN_BLOCK_RANGE = 5000n;
// Cloudflare Workers' free plan caps a single invocation at 50 external subrequests
// total (RPC calls, Etherscan, Supabase — everything), shared across every discovery
// source for every enabled chain in that one scan. Re-checking a contract costs 1-2 of
// those (getPublicDrop, +getAllowedFeeRecipients if restricted), so re-checking the full
// registry every pass doesn't scale once it grows past a few dozen contracts. Capped
// here; the rest rotate in over subsequent scans (see the offset persisted via `cursor`).
const DEFAULT_MAX_REGISTRY_RECHECK = 15;

export type SeaDropDiscoveryConfig = { chainKey: string; rpcUrls: string[]; confirmations?: bigint; client?: PublicClient; cursor?: BlockCursorStore; registry?: ContractRegistry; quantity?: number; etherscan?: { apiKey: string; chainId: number }; maxRegistryRecheck?: number; dropStatusStore?: DropStatusStore };

/**
 * Watches OpenSea's SeaDrop singleton for live mint activity, then confirms each
 * contract's *current* public-drop config directly on-chain (getPublicDrop) before
 * surfacing it — only genuinely free, currently-open drops become candidates, not
 * just "something minted here recently" (price/window can change between mints).
 * Address-scoped, so it works within free RPC providers' restriction on broad
 * (address-less) log queries — see block-source.ts's doc comment for that background.
 * Runs alongside whatever DISCOVERY_MODE is configured, not instead of it: this only
 * catches SeaDrop-launched collections (a large share of real drops, not all of them).
 *
 * A contract only emits SeaDropMint when *someone else* mints it — a drop can be free
 * and open right now with nobody minting it in this particular scan's block window, and
 * without `registry` it would never resurface until its next mint. `registry`, when
 * given, remembers every contract ever seen here and re-checks a rotating, bounded batch
 * of them on every scan (in addition to whatever's newly minting — see rotateBatch), so a
 * known-but-currently-quiet drop keeps being offered for as long as it stays free and
 * open, without the per-scan subrequest count growing unbounded as the registry does.
 *
 * `etherscan`, when given, fetches the log scan via Etherscan's API instead of a raw
 * eth_getLogs call and widens the per-scan range from 50 to 5000 blocks — real SeaDrop
 * mint activity on Ethereum right now is sparse enough (observed: only a couple of
 * events per hour chain-wide) that a 50-block/minute window can go a long time without
 * a fresh event to seed the registry from. A wider range means fewer scans needed to
 * catch that first mint for a given collection.
 *
 * `dropStatusStore`, when given, records the full status of *every* contract checked here
 * (live free, live paid, upcoming, ended) — not just the ones that become a MintCandidate.
 * Without it, "not currently mintable" and "doesn't exist" look identical from the outside:
 * there's no way to answer "what's coming up" or "what's live but not free." See DropStatus's
 * doc comment. Powers the bot's /upcoming command.
 */
export class SeaDropDiscoverySource implements DiscoverySource {
  readonly name = "seadrop";
  constructor(private readonly config: SeaDropDiscoveryConfig) {}

  private get clients(): PublicClient[] { return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }

  async discover(): Promise<MintCandidate[]> {
    for (const client of this.clients) {
      try {
        return await this.discoverWith(client);
      } catch (error) {
        console.error(`[${this.config.chainKey}] seadrop discovery failed:`, (error as Error).message);
      }
    }
    return [];
  }

  private async discoverWith(client: PublicClient): Promise<MintCandidate[]> {
    const latest = await client.getBlockNumber();
    const safeLatest = latest - (this.config.confirmations ?? 2n);
    const cursorKey = `seadrop:${this.config.chainKey}`;
    const stored = this.config.cursor ? await this.config.cursor.get(cursorKey) : undefined;
    const range = this.config.etherscan ? ETHERSCAN_BLOCK_RANGE : MAX_BLOCK_RANGE;
    const defaultStart = safeLatest > 20n ? safeLatest - 20n : 0n;
    const fromBlock = stored !== undefined && stored + 1n <= safeLatest ? stored + 1n : defaultStart;
    if (fromBlock > safeLatest) return [];
    const toBlock = fromBlock + range - 1n < safeLatest ? fromBlock + range - 1n : safeLatest;

    const registryKey = this.config.chainKey;
    const newlySeen = new Set<Address>();
    let eventCount = 0;
    if (this.config.etherscan) {
      const logs = await fetchLogsViaEtherscan(this.config.etherscan, { address: SEADROP_ADDRESS, topics: [SEADROP_MINT_TOPIC0], fromBlock, toBlock });
      eventCount = logs.length;
      for (const log of logs) {
        if (log.topics[1]) newlySeen.add(topicToAddress(log.topics[1]));
      }
    } else {
      const logs = await client.getLogs({ address: SEADROP_ADDRESS, event: SEADROP_MINT_EVENT, fromBlock, toBlock });
      eventCount = logs.length;
      for (const log of logs) {
        if (log.args.nftContract) newlySeen.add(log.args.nftContract);
      }
    }
    const known = this.config.registry ? await this.config.registry.list(registryKey) : [];
    const knownBatch = await this.rotateBatch(known, newlySeen);
    const contracts = new Set<Address>([...knownBatch, ...newlySeen]);

    const candidates: MintCandidate[] = [];
    for (const nftContract of contracts) {
      const candidate = await this.candidateFor(client, nftContract);
      if (candidate) candidates.push(candidate);
    }
    if (this.config.registry) for (const contract of newlySeen) await this.config.registry.add(registryKey, contract);
    console.log(`[${this.config.chainKey}] seadrop: scanned blocks ${fromBlock}-${toBlock}, ${eventCount} mint event(s), ${newlySeen.size} new + ${knownBatch.length}/${known.length} known contract(s) checked, ${candidates.length} currently free+open`);

    if (this.config.cursor) await this.config.cursor.set(cursorKey, toBlock);
    return candidates;
  }

  /** Picks a bounded, rotating slice of `known` to re-check this pass (excluding anything already covered by `newlySeen`), so registry re-checks stay within subrequest budget regardless of how large the registry grows. Advances and persists the rotation offset via `cursor` so every known contract gets revisited over successive scans. */
  private async rotateBatch(known: Address[], newlySeen: Set<Address>): Promise<Address[]> {
    const pending = known.filter((address) => !newlySeen.has(address));
    const limit = this.config.maxRegistryRecheck ?? DEFAULT_MAX_REGISTRY_RECHECK;
    if (pending.length <= limit) return pending;

    const offsetKey = `seadrop-rotation:${this.config.chainKey}`;
    const stored = this.config.cursor ? await this.config.cursor.get(offsetKey) : undefined;
    const offset = Number(stored ?? 0n) % pending.length;
    const batch = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, limit);
    if (this.config.cursor) await this.config.cursor.set(offsetKey, BigInt((offset + limit) % pending.length));
    return batch;
  }

  private async candidateFor(client: PublicClient, nftContract: Address): Promise<MintCandidate | undefined> {
    try {
      const drop = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getPublicDrop", args: [nftContract] });
      // abitype decodes Solidity ints <=48 bits (startTime/endTime/maxTotalMintableByWallet
      // here, all uint48 or smaller) as `number`, and anything wider (mintPrice, uint80) as `bigint`.
      const { mintPrice, startTime, endTime, maxTotalMintableByWallet, restrictFeeRecipients } = drop;
      if (startTime === 0 && endTime === 0 && maxTotalMintableByWallet === 0) return undefined; // unset mapping entry — not a real SeaDrop-registered drop

      const now = Math.floor(Date.now() / 1000);
      const status: DropStatus["status"] = now < startTime ? "upcoming" : endTime !== 0 && now > endTime ? "ended" : mintPrice !== 0n ? "live_paid" : "live_free";
      await this.saveStatus(nftContract, status, mintPrice, startTime, endTime, maxTotalMintableByWallet);
      if (status !== "live_free") return undefined;

      let feeRecipient: Address = OPENSEA_FEE_RECIPIENT;
      if (restrictFeeRecipients) {
        const allowed = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getAllowedFeeRecipients", args: [nftContract] });
        if (!allowed.length) return undefined; // restricted and nothing allowed — no valid call can be built
        feeRecipient = allowed[0];
      }

      const quantity = BigInt(this.config.quantity ?? 1);
      const calldata = encodeFunctionData({ abi: SEADROP_ABI, functionName: "mintPublic", args: [nftContract, feeRecipient, ZERO_ADDRESS, quantity] });

      return {
        id: `${this.config.chainKey}:seadrop:${nftContract}`,
        chainKey: this.config.chainKey,
        contract: SEADROP_ADDRESS,
        source: this.name,
        discoveredAt: new Date().toISOString(),
        mintFunction: "mintPublic",
        calldata,
        valueWei: 0n,
        maxMintsPerWallet: maxTotalMintableByWallet,
        active: true,
        eligible: true,
        metadata: {
          assetType: "nft",
          seadrop: true,
          nftContract,
          mintPrice: "0",
          startTime,
          endTime,
          maxTotalMintableByWallet,
          feeRecipient,
        },
      };
    } catch {
      return undefined; // not a SeaDrop-registered contract, or a transient RPC error
    }
  }

  private async saveStatus(nftContract: Address, status: DropStatus["status"], mintPrice: bigint, startTime: number, endTime: number, maxTotalMintableByWallet: number): Promise<void> {
    if (!this.config.dropStatusStore) return;
    await this.config.dropStatusStore.save({
      id: `${this.config.chainKey}:${nftContract}`,
      chainKey: this.config.chainKey,
      nftContract,
      source: this.name,
      status,
      mintPriceWei: mintPrice.toString(),
      startTime,
      endTime,
      maxTotalMintableByWallet,
      checkedAt: new Date().toISOString(),
    });
  }
}
