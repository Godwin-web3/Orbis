import type { Address } from "viem";
import { parsePriceToWei } from "./price";

export type HoodMintDrop = {
  name: string;
  ticker?: string;
  contract?: Address;
  supply?: number;
  minted?: number;
  status?: string;
  free: boolean;
  priceWei?: bigint;
  url?: string;
};

function asAddress(value: unknown): Address | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/0x[a-fA-F0-9]{40}/);
  if (!match) return undefined;
  return match[0].toLowerCase() as Address;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function fromObject(row: Record<string, unknown>): HoodMintDrop | undefined {
  const contract = asAddress(row.contract ?? row.address ?? row.nft ?? row.collection ?? row.nftContract);
  const name = String(row.name ?? row.title ?? row.collectionName ?? row.ticker ?? "").trim();
  if (!name && !contract) return undefined;
  const price = row.price ?? row.mintPrice ?? row.publicPrice ?? row.phasePrice;
  const priceWei = parsePriceToWei(price);
  const free = row.free === true || row.isFree === true || priceWei === 0n;
  const minted = num(row.minted ?? row.totalMinted ?? row.mintCount ?? row.itemsMinted);
  const supply = num(row.supply ?? row.maxSupply ?? row.totalSupply);
  const status = typeof row.status === "string" ? row.status.toLowerCase() : undefined;
  const ticker = typeof row.ticker === "string" ? row.ticker : typeof row.symbol === "string" ? row.symbol : undefined;
  const url = typeof row.url === "string" ? row.url : typeof row.mintUrl === "string" ? row.mintUrl : undefined;
  return {
    name: name || contract || "unknown",
    free,
    ...(priceWei !== undefined ? { priceWei } : {}),
    ...(ticker ? { ticker } : {}),
    ...(contract ? { contract } : {}),
    ...(minted !== undefined ? { minted } : {}),
    ...(supply !== undefined ? { supply } : {}),
    ...(status ? { status } : {}),
    ...(url ? { url } : {}),
  };
}

export function parseHoodMintPayload(input: unknown): HoodMintDrop[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.flatMap((row) => (row && typeof row === "object" ? [fromObject(row as Record<string, unknown>)].filter(Boolean) : [])) as HoodMintDrop[];
  if (typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const rows = obj.drops ?? obj.collections ?? obj.data ?? obj.results ?? obj.items;
  return parseHoodMintPayload(rows);
}

export function parseHoodMintHtml(html: string): HoodMintDrop[] {
  const chunks = html.split(/<h[23][^>]*>|#{2,3}\s+/i).slice(1);
  const out: HoodMintDrop[] = [];
  const seen = new Set<string>();
  const blocks = chunks.length ? chunks : [html];
  for (const raw of blocks) {
    const text = raw.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const contract = asAddress(text);
    const free = /\bfree\b/i.test(text);
    const mintedMatch = text.match(/(\d[\d,]*)\s*minted/i);
    const supplyMatch = text.match(/(\d[\d,]*)\s*supply/i) ?? text.match(/minted\s+\d[\d,]*\s+(\d[\d,]*)/i);
    const tickerMatch = text.match(/\b([A-Z]{2,8})\s*·/);
    const nameMatch = text.match(/^([A-Za-z0-9][A-Za-z0-9 .'_-]{1,60})/);
    const soldOut = /\bsold out\b/i.test(text);
    const open = /\bopen\b/i.test(text);
    const ethMatch = text.match(/\b(0\.\d{1,6})\b/);
    const priceWei = free ? 0n : ethMatch ? parsePriceToWei(ethMatch[1]) : undefined;
    if (!contract && !nameMatch) continue;
    const drop: HoodMintDrop = {
      name: (nameMatch?.[1] ?? contract ?? "unknown").trim(),
      free,
      ...(priceWei !== undefined ? { priceWei } : {}),
      status: soldOut ? "sold_out" : open ? "open" : undefined,
      ...(contract ? { contract } : {}),
      ...(tickerMatch ? { ticker: tickerMatch[1] } : {}),
      ...(mintedMatch ? { minted: Number(mintedMatch[1].replace(/,/g, "")) } : {}),
      ...(supplyMatch ? { supply: Number(supplyMatch[1].replace(/,/g, "")) } : {}),
    };
    const key = drop.contract ?? drop.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(drop);
  }
  return out;
}

export async function fetchHoodMintDrops(opts: { urls?: string[]; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<HoodMintDrop[]> {
  const urls = opts.urls ?? (process.env.HOODMINT_DROPS_URL ?? "https://hoodmint.online/api/drops,https://hoodmint.online/api/drops/open,https://hoodmint.online/drops/open")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.VALUE_ORACLE_TIMEOUT_MS ?? "2500");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const found: HoodMintDrop[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json, text/html" }, signal: controller.signal });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("json")) {
        for (const drop of parseHoodMintPayload(await response.json())) {
          const key = drop.contract ?? drop.name;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(drop);
        }
      } else {
        for (const drop of parseHoodMintHtml(await response.text())) {
          const key = drop.contract ?? drop.name;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(drop);
        }
      }
      if (found.some((drop) => drop.contract)) break;
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  return found;
}
