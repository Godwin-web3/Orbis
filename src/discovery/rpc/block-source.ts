import { createPublicClient, http, pad, parseAbiItem, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import { detectMintFunction, identifyCandidate } from "../contract/detector";
import type { BlockCursorStore } from "./block-cursor";
import { fetchLogsViaEtherscan } from "./etherscan-logs";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as `0x${string}`;
const ZERO_ADDRESS_TOPIC = pad(ZERO_ADDRESS, { size: 32 });

// Per-scan block range caps. Conservative defaults since free/public RPC providers often
// reject large eth_getLogs ranges; on failure we retry once with a much smaller range
// rather than giving up the whole pass. Etherscan doesn't have that restriction, so a
// source configured with `etherscan` uses a much wider range instead (see fetchLogs).
const MAX_BLOCK_RANGE = 50n;
const RETRY_BLOCK_RANGE = 10n;
const ETHERSCAN_BLOCK_RANGE = 5000n;

export type BlockDiscoveryConfig = { chainKey: string; rpcUrls: string[]; startBlock?: bigint; confirmations?: bigint; client?: PublicClient; cursor?: BlockCursorStore; etherscan?: { apiKey: string; chainId: number } };

function capRange(from: bigint, safeLatest: bigint, max: bigint): bigint {
  const capped = from + max - 1n;
  return capped < safeLatest ? capped : safeLatest;
}

type LogLike = { address: Address; topics: readonly `0x${string}`[] };

/**
 * Finds NFT mints by watching for ERC-721 `Transfer` events where `from` is the zero
 * address — that IS a mint, emitted by any contract (new or deployed long ago) the
 * moment someone mints from it. This catches mints from already-existing collections
 * that just opened up, not just brand-new deployments, and a single eth_getLogs call
 * covers a whole block range cheaply (unlike checking every transaction's receipt).
 *
 * Two things verified directly against real RPC responses, not assumed:
 * 1. Some free/public providers (confirmed: Ethereum's publicnode.com endpoint) reject
 *    an address-less eth_getLogs call outright ("Please specify an address..."), since
 *    it's an expensive whole-chain query. When that happens we fall back to the
 *    original per-block "new contract deployment" scan for that pass — narrower (misses
 *    mints from already-existing contracts) but still functional on a provider that
 *    blocks broad log queries. Passing `etherscan` (see fetchLogsViaEtherscan) sidesteps
 *    this restriction entirely and widens the per-scan block range from 50 to 5000, since
 *    Etherscan's API doesn't reject address-less queries or large ranges the way a public
 *    RPC node does.
 * 2. ERC-20 `Transfer(address,address,uint256)` and ERC-721 `Transfer(address,address,
 *    uint256)` share an identical topic0 hash — the only on-the-wire difference is
 *    whether tokenId is indexed (ERC-721: 4 topics, empty data) or not (ERC-20: 3
 *    topics, value in data). Confirmed on Robinhood Chain: an unfiltered scan picks up
 *    ERC-20 mints too. Filtered by topics.length === 4 below.
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
      console.log(`[${this.config.chainKey}] caught up (cursor ${stored ?? "none"}, safeLatest ${safeLatest}), nothing to scan yet`);
      return [];
    }

    let toBlock = capRange(fromBlock, safeLatest, MAX_BLOCK_RANGE);
    const logs = await this.fetchLogs(client, fromBlock, safeLatest, (range) => { toBlock = range; });

    const candidates: MintCandidate[] = logs
      ? await this.candidatesFromLogs(client, logs, fromBlock, toBlock)
      : await this.candidatesFromNewContracts(client, fromBlock, (block) => { toBlock = block; });

    if (this.config.cursor) await this.config.cursor.set(this.config.chainKey, toBlock);
    return candidates;
  }

  /** Returns undefined (rather than throwing) when the provider rejects broad log queries, so the caller can fall back instead of failing the whole pass. */
  private async fetchLogs(client: PublicClient, fromBlock: bigint, safeLatest: bigint, setToBlock: (block: bigint) => void): Promise<LogLike[] | undefined> {
    if (this.config.etherscan) {
      const toBlock = capRange(fromBlock, safeLatest, ETHERSCAN_BLOCK_RANGE);
      try {
        const logs = await fetchLogsViaEtherscan(this.config.etherscan, { topics: [TRANSFER_TOPIC0, ZERO_ADDRESS_TOPIC], fromBlock, toBlock });
        setToBlock(toBlock);
        return logs;
      } catch (error) {
        console.error(`[${this.config.chainKey}] Etherscan getLogs failed for range ${fromBlock}-${toBlock}:`, (error as Error).message);
        return undefined;
      }
    }

    let toBlock = capRange(fromBlock, safeLatest, MAX_BLOCK_RANGE);
    try {
      const logs = await client.getLogs({ event: TRANSFER_EVENT, args: { from: ZERO_ADDRESS }, fromBlock, toBlock });
      setToBlock(toBlock);
      return logs;
    } catch (error) {
      console.error(`[${this.config.chainKey}] getLogs failed for range ${fromBlock}-${toBlock}:`, (error as Error).message);
    }
    try {
      toBlock = capRange(fromBlock, safeLatest, RETRY_BLOCK_RANGE);
      const logs = await client.getLogs({ event: TRANSFER_EVENT, args: { from: ZERO_ADDRESS }, fromBlock, toBlock });
      setToBlock(toBlock);
      return logs;
    } catch (error) {
      console.error(`[${this.config.chainKey}] getLogs still failing on a smaller range, falling back to per-block new-contract scan:`, (error as Error).message);
      return undefined;
    }
  }

  private async candidatesFromLogs(client: PublicClient, logs: LogLike[], fromBlock: bigint, toBlock: bigint): Promise<MintCandidate[]> {
    // ERC-721 has tokenId indexed (topic0 + 3 indexed args = 4 topics, empty data).
    // ERC-20 shares the same topic0 but only indexes from/to (3 topics, value in data).
    const contracts = new Set<Address>();
    for (const log of logs) {
      if (log.topics.length !== 4) continue;
      contracts.add(log.address);
    }
    console.log(`[${this.config.chainKey}] scanned blocks ${fromBlock}-${toBlock}: ${logs.length} log(s), ${contracts.size} ERC-721 contract(s)`);

    const candidates: MintCandidate[] = [];
    for (const contract of contracts) candidates.push(...(await this.candidatesFor(client, contract)));
    return candidates;
  }

  /** Fallback for a provider that won't allow address-less eth_getLogs: scan one block's transactions for direct contract creations (misses mints from already-deployed contracts, but still functional). */
  private async candidatesFromNewContracts(client: PublicClient, block: bigint, setToBlock: (block: bigint) => void): Promise<MintCandidate[]> {
    setToBlock(block);
    const { transactions } = await client.getBlock({ blockNumber: block, includeTransactions: true });
    const candidates: MintCandidate[] = [];
    for (const transaction of transactions) {
      if (typeof transaction === "string" || transaction.to) continue;
      const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
      if (receipt.contractAddress) candidates.push(...(await this.candidatesFor(client, receipt.contractAddress)));
    }
    console.log(`[${this.config.chainKey}] fallback new-contract scan at block ${block}: ${candidates.length} candidate(s)`);
    return candidates;
  }

  private async candidatesFor(client: PublicClient, contract: Address): Promise<MintCandidate[]> {
    const bytecode = await client.getBytecode({ address: contract });
    if (!bytecode) return [];
    return detectMintFunction(bytecode).map((mintFunction) => {
      const candidate = identifyCandidate(contract, this.config.chainKey, this.name, mintFunction);
      return { ...candidate, metadata: { ...candidate.metadata, mintEventObserved: true } };
    });
  }
}
