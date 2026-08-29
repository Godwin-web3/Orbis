import type { Address } from "viem";

const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const MAX_PAGES = 10; // safety cap: 10k logs per call is far beyond one scan pass's needs

export type EtherscanLog = { address: Address; topics: `0x${string}`[]; data: `0x${string}`; blockNumber: bigint };

type EtherscanResponse = { status: string; message: string; result: unknown };
type EtherscanLogRow = { address: string; topics: string[]; data: string; blockNumber: string };

/**
 * A single scan pass runs every discovery source concurrently (see MintEngine.run), and
 * on Ethereum both BlockContractDiscoverySource and SeaDropDiscoverySource call this
 * module with the same API key at essentially the same instant — plus pagination within
 * one call adds more. That reliably tripped Etherscan's per-second cap ("Max calls per
 * sec rate limit reached"). This throttle is shared module state (not per-call-site), so
 * every caller queues behind the same clock regardless of which source or which page.
 * Read fresh each call (not cached at module load) so a test can set it to 0.
 */
let lastCallAt = 0;
let throttleQueue: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const scheduled = throttleQueue.then(async () => {
    const minIntervalMs = Number(process.env.ETHERSCAN_MIN_INTERVAL_MS ?? "400");
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
  });
  throttleQueue = scheduled.catch(() => {});
  return scheduled;
}

/**
 * Fetches event logs via Etherscan's unified v2 API (one API key, `chainid` param
 * selects the network) instead of a raw eth_getLogs JSON-RPC call. Two things free/public
 * RPC providers on Ethereum don't reliably give: address-less topic-only queries (needed
 * for a chain-wide "any ERC-721 mint" scan — see block-source.ts), and wide block ranges
 * without an "archive node" restriction (needed to backfill SeaDrop's ContractRegistry
 * further back than a live 50-block window can reach — see seadrop-source.ts).
 * Paginated via Etherscan's documented page/offset params, capped at MAX_PAGES per call.
 */
export async function fetchLogsViaEtherscan(
  config: { apiKey: string; chainId: number },
  params: { address?: Address; topics: (`0x${string}` | null)[]; fromBlock: bigint; toBlock: bigint },
): Promise<EtherscanLog[]> {
  const results: EtherscanLog[] = [];
  const offset = 1000;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(ETHERSCAN_API_BASE);
    url.searchParams.set("chainid", String(config.chainId));
    url.searchParams.set("module", "logs");
    url.searchParams.set("action", "getLogs");
    url.searchParams.set("fromBlock", params.fromBlock.toString());
    url.searchParams.set("toBlock", params.toBlock.toString());
    if (params.address) url.searchParams.set("address", params.address);
    params.topics.forEach((topic, i) => { if (topic) url.searchParams.set(`topic${i}`, topic); });
    for (let i = 0; i < params.topics.length - 1; i++) {
      if (params.topics[i] && params.topics[i + 1]) url.searchParams.set(`topic${i}_${i + 1}_opr`, "and");
    }
    url.searchParams.set("page", String(page));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("apikey", config.apiKey);

    await throttle();
    const response = await fetch(url.toString());
    const body = (await response.json()) as EtherscanResponse;
    if (body.status !== "1") {
      if (body.message === "No records found") break;
      // Etherscan's `message` is always the literal string "NOTOK" on failure — the actual
      // reason (bad key, rate limit, invalid params, etc.) is in `result` instead.
      throw new Error(`Etherscan getLogs failed: ${body.message} — ${String(body.result)}`);
    }

    const rows = body.result as EtherscanLogRow[];
    for (const row of rows) results.push({ address: row.address as Address, topics: row.topics as `0x${string}`[], data: row.data as `0x${string}`, blockNumber: BigInt(row.blockNumber) });
    if (rows.length < offset) break;
  }

  return results;
}
