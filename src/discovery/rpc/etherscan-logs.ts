import type { Address } from "viem";

const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const MAX_PAGES = 10; // safety cap: 10k logs per call is far beyond one scan pass's needs

export type EtherscanLog = { address: Address; topics: `0x${string}`[]; data: `0x${string}`; blockNumber: bigint };

type EtherscanResponse = { status: string; message: string; result: unknown };
type EtherscanLogRow = { address: string; topics: string[]; data: string; blockNumber: string };

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

    const response = await fetch(url.toString());
    const body = (await response.json()) as EtherscanResponse;
    if (body.status !== "1") {
      if (body.message === "No records found") break;
      throw new Error(`Etherscan getLogs failed: ${body.message}`);
    }

    const rows = body.result as EtherscanLogRow[];
    for (const row of rows) results.push({ address: row.address as Address, topics: row.topics as `0x${string}`[], data: row.data as `0x${string}`, blockNumber: BigInt(row.blockNumber) });
    if (rows.length < offset) break;
  }

  return results;
}
