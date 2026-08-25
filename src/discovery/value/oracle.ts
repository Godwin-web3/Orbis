import type { Address } from "viem";
import type { MintCandidate } from "../../domain/types";
import { scoreMintValue } from "./score";

const RESERVOIR_HOST: Record<string, string> = {
  ethereum: "https://api.reservoir.tools",
  base: "https://api-base.reservoir.tools",
};

type ReservoirCollection = {
  name?: string;
  tokenCount?: string;
  ownerCount?: string;
  twitterUsername?: string;
  openseaVerificationStatus?: string;
  volume?: { allTime?: number };
  floorAsk?: { price?: { amount?: { native?: number } } };
};

type ReservoirResponse = { collections?: ReservoirCollection[] };

export type MarketSnapshot = {
  name?: string;
  floorNative?: number;
  volumeAllTimeNative?: number;
  ownerCount?: number;
  tokenCount?: number;
  twitter?: boolean;
  verified?: boolean;
};

export async function fetchReservoirCollection(chainKey: string, contract: Address, fetchImpl: typeof fetch = fetch): Promise<MarketSnapshot | undefined> {
  const host = RESERVOIR_HOST[chainKey];
  if (!host) return undefined;
  const headers: Record<string, string> = { accept: "application/json" };
  const key = process.env.RESERVOIR_API_KEY;
  if (key) headers["x-api-key"] = key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.VALUE_ORACLE_TIMEOUT_MS ?? "2500"));
  try {
    const response = await fetchImpl(`${host}/collections/v7?id=${contract}`, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    const body = (await response.json()) as ReservoirResponse;
    const collection = body.collections?.[0];
    if (!collection) return undefined;
    const floorNative = collection.floorAsk?.price?.amount?.native;
    const volumeAllTimeNative = collection.volume?.allTime;
    const ownerCount = collection.ownerCount !== undefined ? Number(collection.ownerCount) : undefined;
    const tokenCount = collection.tokenCount !== undefined ? Number(collection.tokenCount) : undefined;
    const verified = ["verified", "approved"].includes((collection.openseaVerificationStatus ?? "").toLowerCase());
    return {
      ...(collection.name ? { name: collection.name } : {}),
      ...(floorNative !== undefined && Number.isFinite(floorNative) ? { floorNative } : {}),
      ...(volumeAllTimeNative !== undefined && Number.isFinite(volumeAllTimeNative) ? { volumeAllTimeNative } : {}),
      ...(ownerCount !== undefined && Number.isFinite(ownerCount) ? { ownerCount } : {}),
      ...(tokenCount !== undefined && Number.isFinite(tokenCount) ? { tokenCount } : {}),
      twitter: Boolean(collection.twitterUsername),
      verified,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Attaches floor / volume / demand score onto a candidate. Safe to call with no API key. */
export class CollectionValueOracle {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async enrich(candidate: MintCandidate): Promise<MintCandidate> {
    if ((process.env.VALUE_ORACLE ?? "on") === "off") return candidate;
    const nft = (typeof candidate.metadata.nftContract === "string" ? candidate.metadata.nftContract : candidate.contract) as Address;
    const market = await fetchReservoirCollection(candidate.chainKey, nft, this.fetchImpl);
    const startTime = Number(candidate.metadata.startTime ?? 0);
    const now = Math.floor(Date.now() / 1000);
    const scored = scoreMintValue({
      name: (market?.name ?? (typeof candidate.metadata.name === "string" ? candidate.metadata.name : undefined)),
      floorNative: market?.floorNative,
      volumeAllTimeNative: market?.volumeAllTimeNative,
      ownerCount: market?.ownerCount,
      tokenCount: market?.tokenCount,
      recentMints: Number(candidate.metadata.recentMints ?? 0),
      twitter: market?.twitter,
      verified: market?.verified,
      openedAgoSeconds: startTime > 0 ? now - startTime : undefined,
    });
    return {
      ...candidate,
      metadata: {
        ...candidate.metadata,
        ...(market?.name && !candidate.metadata.name ? { name: market.name } : {}),
        ...(market?.floorNative !== undefined ? { floorNative: market.floorNative } : {}),
        ...(market?.volumeAllTimeNative !== undefined ? { volumeAllTimeNative: market.volumeAllTimeNative } : {}),
        ...(market?.ownerCount !== undefined ? { ownerCount: market.ownerCount } : {}),
        estimatedValueNative: scored.estimatedValueNative,
        valueScore: scored.valueScore,
        valueSignal: scored.hasSignal,
        valueReasons: scored.reasons,
      },
    };
  }
}
