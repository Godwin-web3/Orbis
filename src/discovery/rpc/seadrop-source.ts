import { createPublicClient, http, encodeFunctionData, parseAbiItem, type Abi, type Address, type PublicClient } from "viem";
import type { DiscoverySource, DropStatusStore } from "../../domain/ports";
import type { DropStatus, MintCandidate } from "../../domain/types";
import type { BlockCursorStore } from "./block-cursor";
import type { ContractRegistry } from "./contract-registry";
import { fetchLogsViaEtherscan } from "./etherscan-logs";
import { readErc721Name } from "./erc721-name";

export const SEADROP_ADDRESS: Address = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPENSEA_FEE_RECIPIENT: Address = "0x0000a26b00c1F0DF003000390027140000fAa719";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const SEADROP_MINT_TOPIC0 = "0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6" as `0x${string}`;
const SEADROP_MINT_EVENT = parseAbiItem(
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)"
);

function topicToAddress(topic: `0x${string}`): Address {
  return `0x${topic.slice(-40)}` as Address;
}

function capRange(from: bigint, safeLatest: bigint, max: bigint): bigint {
  const capped = from + max - 1n;
  return capped < safeLatest ? capped : safeLatest;
}

export const SEADROP_ABI = [
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

export type PublicDrop = { mintPrice: bigint; startTime: number; endTime: number; maxTotalMintableByWallet: number; feeBps: number; restrictFeeRecipients: boolean };

export async function readPublicDrop(client: PublicClient, nftContract: Address): Promise<PublicDrop | undefined> {
  try {
    const drop = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getPublicDrop", args: [nftContract] });
    if (drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0) return undefined;
    return drop;
  } catch {
    return undefined;
  }
}

export async function resolveFeeRecipient(client: PublicClient, nftContract: Address, restrictFeeRecipients: boolean): Promise<Address | undefined> {
  if (!restrictFeeRecipients) return OPENSEA_FEE_RECIPIENT;
  const allowed = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getAllowedFeeRecipients", args: [nftContract] });
  return allowed[0];
}

export function encodeMintPublic(nftContract: Address, feeRecipient: Address, quantity: bigint): `0x${string}` {
  return encodeFunctionData({ abi: SEADROP_ABI, functionName: "mintPublic", args: [nftContract, feeRecipient, ZERO_ADDRESS, quantity] });
}

const MAX_BLOCK_RANGE = 50n;
const RETRY_BLOCK_RANGE = 10n;
const ETHERSCAN_BLOCK_RANGE = 5000n;
const DEFAULT_MAX_REGISTRY_RECHECK = 15;

export type SeaDropDiscoveryConfig = { chainKey: string; rpcUrls: string[]; confirmations?: bigint; client?: PublicClient; cursor?: BlockCursorStore; registry?: ContractRegistry; quantity?: number; etherscan?: { apiKey: string; chainId: number }; maxRegistryRecheck?: number; dropStatusStore?: DropStatusStore; boosts?: () => Promise<{ contract: `0x${string}`; recentMints?: number; uniqueMinters?: number; name?: string; floorNative?: number }[]> };

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
    const defaultStart = safeLatest > 20n ? safeLatest - 20n : 0n;
    const fromBlock = stored !== undefined && stored + 1n <= safeLatest ? stored + 1n : defaultStart;
    if (fromBlock > safeLatest) return [];

    const registryKey = this.config.chainKey;
    const newlySeen = new Set<Address>();
    let eventCount = 0;
    let toBlock: bigint;
    if (this.config.etherscan) {
      toBlock = capRange(fromBlock, safeLatest, ETHERSCAN_BLOCK_RANGE);
      const logs = await fetchLogsViaEtherscan(this.config.etherscan, { address: SEADROP_ADDRESS, topics: [SEADROP_MINT_TOPIC0], fromBlock, toBlock });
      eventCount = logs.length;
      for (const log of logs) {
        if (log.topics[1]) newlySeen.add(topicToAddress(log.topics[1]));
      }
    } else {
      const result = await this.fetchLogsWithRetry(client, fromBlock, safeLatest);
      toBlock = result.toBlock;
      eventCount = result.logs.length;
      for (const log of result.logs) {
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

  private async fetchLogsWithRetry(client: PublicClient, fromBlock: bigint, safeLatest: bigint) {
    let toBlock = capRange(fromBlock, safeLatest, MAX_BLOCK_RANGE);
    try {
      const logs = await client.getLogs({ address: SEADROP_ADDRESS, event: SEADROP_MINT_EVENT, fromBlock, toBlock });
      return { logs, toBlock };
    } catch (error) {
      console.error(`[${this.config.chainKey}] seadrop getLogs failed for range ${fromBlock}-${toBlock}:`, (error as Error).message);
    }
    toBlock = capRange(fromBlock, safeLatest, RETRY_BLOCK_RANGE);
    const logs = await client.getLogs({ address: SEADROP_ADDRESS, event: SEADROP_MINT_EVENT, fromBlock, toBlock });
    return { logs, toBlock };
  }

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
      const drop = await readPublicDrop(client, nftContract);
      if (!drop) return undefined;
      const { mintPrice, startTime, endTime, maxTotalMintableByWallet, restrictFeeRecipients } = drop;
      const now = Math.floor(Date.now() / 1000);
      const status: DropStatus["status"] = now < startTime ? "upcoming" : endTime !== 0 && now > endTime ? "ended" : mintPrice !== 0n ? "live_paid" : "live_free";
      const name = this.config.dropStatusStore ? await readErc721Name(client, nftContract) : undefined;
      await this.saveStatus(nftContract, status, name, mintPrice, startTime, endTime, maxTotalMintableByWallet);
      if (status !== "live_free") return undefined;
      const feeRecipient = await resolveFeeRecipient(client, nftContract, restrictFeeRecipients);
      if (!feeRecipient) return undefined;
      const quantity = BigInt(this.config.quantity ?? 1);
      const calldata = encodeMintPublic(nftContract, feeRecipient, quantity);
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
          ...(name ? { name } : {}),
          mintPrice: "0",
          startTime,
          endTime,
          maxTotalMintableByWallet,
          feeRecipient,
        },
      };
    } catch {
      return undefined;
    }
  }

  private async saveStatus(nftContract: Address, status: DropStatus["status"], name: string | undefined, mintPrice: bigint, startTime: number, endTime: number, maxTotalMintableByWallet: number): Promise<void> {
    if (!this.config.dropStatusStore) return;
    await this.config.dropStatusStore.save({
      id: `${this.config.chainKey}:${nftContract}`,
      chainKey: this.config.chainKey,
      nftContract,
      source: this.name,
      status,
      ...(name ? { name } : {}),
      mintPriceWei: mintPrice.toString(),
      startTime,
      endTime,
      maxTotalMintableByWallet,
      checkedAt: new Date().toISOString(),
    });
  }
}
