import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { detectMintFunction, identifyCandidate } from "../contract/detector";
import type { BlockCursorStore } from "./block-cursor";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// Per-scan block range caps. Conservative defaults since free/public RPC providers often
// reject large eth_getLogs ranges; on failure we retry once with a much smaller range
// rather than giving up the whole pass.
const MAX_BLOCK_RANGE = 50n;
const RETRY_BLOCK_RANGE = 10n;

export type BlockDiscoveryConfig = { chainKey: string; rpcUrls: string[]; startBlock?: bigint; confirmations?: bigint; client?: PublicClient; cursor?: BlockCursorStore };

function capRange(from: bigint, safeLatest: bigint, max: bigint): bigint {
  const capped = from + max - 1n;
  return capped < safeLatest ? capped : safeLatest;
}

/**
 * Finds NFT mints by watching for ERC-721 `Transfer` events where `from` is the zero
 * address — that IS a mint, emitted by any contract (new or deployed long ago) the
 * moment someone mints from it. This catches mints from already-existing collections
 * that just opened up, not just brand-new deployments, and a single eth_getLogs call
 * covers a whole block range cheaply (unlike checking every transaction's receipt).
 *
 * A persisted cursor (see BlockCursorStore) tracks the last block scanned per chain so
 * consecutive scans cover contiguous ranges instead of only sampling a fixed recent
 * window each time and silently missing everything in between.
 */
export class BlockContractDiscoverySource implements DiscoverySource {
  readonly name = "block-contracts";
  constructor(private readonly config: BlockDiscoveryConfig) {}

  private get clients(): PublicClient[] { return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }

  async discover(): Promise<MintCandidate[]> {
    for (const client of this.clients) {
      try {
        return await this.discoverWith(client);
      } catch (error) {
        console.error(`[${this.config.chainKey}] block discovery failed:`, (error as Error).message);
      }
    }
    return [];
  }

  private async discoverWith(client: PublicClient): Promise<MintCandidate[]> {
    const latest = await client.getBlockNumber();
    const safeLatest = latest - (this.config.confirmations ?? 2n);
    const stored = this.config.cursor ? await this.config.cursor.get(this.config.chainKey) : undefined;
    const defaultStart = safeLatest > 20n ? safeLatest - 20n : 0n;
    const fromBlock = this.config.startBlock ?? (stored !== undefined && stored + 1n <= safeLatest ? stored + 1n : defaultStart);
    if (fromBlock > safeLatest) {
      console.log(`[${this.config.chainKey}] block discovery: caught up (cursor ${stored ?? "none"}, safeLatest ${safeLatest}), nothing to scan yet`);
      return [];
    }

    let toBlock = capRange(fromBlock, safeLatest, MAX_BLOCK_RANGE);
    let logs;
    try {
      logs = await client.getLogs({ event: TRANSFER_EVENT, args: { from: ZERO_ADDRESS }, fromBlock, toBlock });
    } catch (error) {
      console.error(`[${this.config.chainKey}] getLogs failed for range ${fromBlock}-${toBlock}, retrying smaller:`, (error as Error).message);
      toBlock = capRange(fromBlock, safeLatest, RETRY_BLOCK_RANGE);
      logs = await client.getLogs({ event: TRANSFER_EVENT, args: { from: ZERO_ADDRESS }, fromBlock, toBlock });
    }

    const contracts = new Set<Address>();
    for (const log of logs) contracts.add(log.address);
    console.log(`[${this.config.chainKey}] scanned blocks ${fromBlock}-${toBlock}: ${logs.length} mint-transfer log(s), ${contracts.size} distinct contract(s)`);

    const candidates: MintCandidate[] = [];
    for (const contract of contracts) {
      const bytecode = await client.getBytecode({ address: contract });
      if (!bytecode) continue;
      for (const mintFunction of detectMintFunction(bytecode)) {
        const candidate = identifyCandidate(contract, this.config.chainKey, this.name, mintFunction);
        candidates.push({ ...candidate, metadata: { ...candidate.metadata, mintEventObserved: true } });
      }
    }

    if (this.config.cursor) await this.config.cursor.set(this.config.chainKey, toBlock);
    return candidates;
  }
}
