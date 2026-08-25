import type { Address } from "viem";

const RESERVOIR_HOST: Record<string, string> = {
  ethereum: "https://api.reservoir.tools",
  base: "https://api-base.reservoir.tools",
};

export type TrendingMint = {
  contract: Address;
  name?: string;
  mintCount: number;
  uniqueMinters?: number;
  floorNative?: number;
};

type ReservoirRow = {
  id?: string;
  mintCount?: number;
  count?: number;
  uniqueMinters?: number;
  collection?: {
    id?: string;
    primaryContract?: string;
    name?: string;
    floorAsk?: { price?: { amount?: { native?: number } } };
  };
};

function asAddress(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  const id = value.split(":")[0];
  if (!/^0x[a-fA-F0-9]{40}$/.test(id)) return undefined;
  return id.toLowerCase() as Address;
}

function parseRow(row: ReservoirRow): TrendingMint | undefined {
  const contract = asAddress(row.collection?.primaryContract ?? row.collection?.id ?? row.id);
  if (!contract) return undefined;
  const mintCount = Number(row.mintCount ?? row.count ?? 0);
  const uniqueMinters = row.uniqueMinters !== undefined ? Number(row.uniqueMinters) : undefined;
  const floorNative = row.collection?.floorAsk?.price?.amount?.native;
  return {
    contract,
    mintCount: Number.isFinite(mintCount) ? mintCount : 0,
    ...(row.collection?.name ? { name: row.collection.name } : {}),
    ...(uniqueMinters !== undefined && Number.isFinite(uniqueMinters) ? { uniqueMinters } : {}),
    ...(floorNative !== undefined && Number.isFinite(floorNative) ? { floorNative } : {}),
  };
}

/** Free mints people are actually hitting right now. Reservoir only indexes ETH / Base — not Robinhood. */
export async function fetchTrendingFreeMints(
  chainKey: string,
  opts: { period?: string; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<TrendingMint[]> {
  const host = RESERVOIR_HOST[chainKey];
  if (!host) return [];
  const period = opts.period ?? process.env.TRENDING_PERIOD ?? "10m";
  const limit = opts.limit ?? Number(process.env.TRENDING_LIMIT ?? "20");
  const headers: Record<string, string> = { accept: "application/json" };
  const key = process.env.RESERVOIR_API_KEY;
  if (key) headers["x-api-key"] = key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.VALUE_ORACLE_TIMEOUT_MS ?? "2500"));
  try {
    const url = `${host}/collections/trending-mints/v1?period=${encodeURIComponent(period)}&type=free&limit=${limit}`;
    const response = await (opts.fetchImpl ?? fetch)(url, { headers, signal: controller.signal });
    if (!response.ok) return [];
    const body = (await response.json()) as { mints?: ReservoirRow[]; collections?: ReservoirRow[] };
    const rows = body.mints ?? body.collections ?? [];
    const seen = new Set<string>();
    const out: TrendingMint[] = [];
    for (const row of rows) {
      const parsed = parseRow(row);
      if (!parsed || seen.has(parsed.contract)) continue;
      seen.add(parsed.contract);
      out.push(parsed);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
