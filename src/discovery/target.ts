import { createPublicClient, http, type Address } from "viem";
import { detectMintFunction, identifyCandidate } from "./contract/detector";
import { readErc721Name } from "./rpc/erc721-name";
import { dropLink } from "../chains/registry";
import type { MintEngine } from "../app/engine";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const EXPLORER_HOST_TO_CHAIN: Record<string, string> = {
  "etherscan.io": "ethereum",
  "basescan.org": "base",
  "arbiscan.io": "arbitrum",
  "optimistic.etherscan.io": "optimism",
  "polygonscan.com": "polygon",
  "robinhoodchain.blockscout.com": "robinhood",
};

const OPENSEA_CHAIN_SLUG: Record<string, string> = { ethereum: "ethereum", base: "base", matic: "polygon", polygon: "polygon", arbitrum: "arbitrum", optimism: "optimism" };

export type ResolvedTarget = { chainKey: string; contract: Address };

/**
 * Best-effort: reliably handles a bare address, OpenSea asset URLs, Zora collect URLs,
 * and common block-explorer address URLs. A URL that doesn't match a known pattern
 * (e.g. a collection-slug-only OpenSea URL, or an arbitrary launchpad's own domain)
 * can't be resolved without either an API key we don't have configured or executing
 * that site's JavaScript — falls through to undefined so the caller can ask the user
 * for the raw contract address instead.
 */
export function parseTargetInput(input: string, defaultChainKey?: string): ResolvedTarget | undefined {
  const trimmed = input.trim();
  if (HEX_ADDRESS.test(trimmed)) return defaultChainKey ? { chainKey: defaultChainKey, contract: trimmed as Address } : undefined;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "opensea.io" && segments[0] === "assets") {
    const address = segments.find((segment) => HEX_ADDRESS.test(segment));
    if (!address) return undefined;
    const chainSlug = segments[1] !== address ? segments[1] : undefined;
    const chainKey = (chainSlug && OPENSEA_CHAIN_SLUG[chainSlug]) ?? defaultChainKey;
    return chainKey ? { chainKey, contract: address as Address } : undefined;
  }

  if (host === "zora.co" && segments[0] === "collect" && segments[1]) {
    const [chainSlug, address] = segments[1].split(":");
    if (!address || !HEX_ADDRESS.test(address)) return undefined;
    const chainKey = OPENSEA_CHAIN_SLUG[chainSlug] ?? defaultChainKey;
    return chainKey ? { chainKey, contract: address as Address } : undefined;
  }

  if (EXPLORER_HOST_TO_CHAIN[host]) {
    const address = segments.find((segment) => HEX_ADDRESS.test(segment));
    if (address) return { chainKey: EXPLORER_HOST_TO_CHAIN[host], contract: address as Address };
  }

  const address = segments.find((segment) => HEX_ADDRESS.test(segment));
  return address && defaultChainKey ? { chainKey: defaultChainKey, contract: address as Address } : undefined;
}

/**
 * Resolves a manually-supplied contract and runs it through the SAME classify ->
 * simulate -> policy -> prepare pipeline as auto-discovery (via engine.processOne) —
 * a user-supplied target gets no less scrutiny than one the engine found itself.
 */
export async function processTarget(engine: MintEngine, rpcUrls: string[], target: ResolvedTarget): Promise<string> {
  if (!rpcUrls.length) return `No RPC configured for chain "${target.chainKey}". Set its *_RPC_URL and enable it in ENABLED_CHAINS first.`;
  const client = createPublicClient({ transport: http(rpcUrls[0]) });
  const bytecode = await client.getBytecode({ address: target.contract });
  if (!bytecode) return `No contract found at ${target.contract} on ${target.chainKey}.`;

  const name = await readErc721Name(client, target.contract);
  const link = dropLink(target.chainKey, target.contract);
  const title = name ? `${name} (${target.contract})` : target.contract;
  const header = [title, ...(link ? [link] : []), `chain: ${target.chainKey}`];

  const mintFunctions = detectMintFunction(bytecode);
  if (!mintFunctions.length) {
    return [...header, "", "Couldn't detect a recognizable mint function (mint/publicMint/freeMint/claim). It may use a non-standard function name — this bot can't guess those yet."].join("\n");
  }

  const lines: string[] = [];
  for (const mintFunction of mintFunctions) {
    const candidate = identifyCandidate(target.contract, target.chainKey, "target", mintFunction);
    const result = await engine.processOne(candidate);
    lines.push(`${mintFunction}: ${result.decision === "PASS" ? "PASS — check /prepared" : `${result.decision} (${result.reasons.join("; ") || "no reason given"})`}`);
  }
  return [...header, "", ...lines].join("\n");
}
