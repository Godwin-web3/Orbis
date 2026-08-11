import type { Abi, Address } from "viem";
import type { ContractInspector } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";

type ClaimKind = "merkle" | "signature";

type ClaimData = {
  kind: ClaimKind;
  args: unknown[];
  source: string;
  typedData?: Record<string, unknown>;
};

export type ClaimDataProvider = (candidate: MintCandidate, kind: ClaimKind) => Promise<ClaimData | undefined>;

const proofPattern = /proof|merkle/i;
const signaturePattern = /signature|sig|authorization|auth/i;

function candidateAbi(candidate: MintCandidate): Abi | undefined {
  if (Array.isArray(candidate.metadata.abi)) return candidate.metadata.abi as Abi;
  if (Array.isArray(candidate.abi)) return candidate.abi as Abi;
  return undefined;
}

function claimFragment(candidate: MintCandidate) {
  const abi = candidateAbi(candidate);
  if (!abi || !candidate.mintFunction) return undefined;
  const functions = abi.filter((item) => item.type === "function" && item.name === candidate.mintFunction);
  if (!functions.length) return undefined;
  const configured = candidate.metadata.args;
  if (!Array.isArray(configured)) return functions[0];
  return functions.find((item) => item.type === "function" && item.inputs.length === configured.length) ?? functions[0];
}

function requiredClaimKind(candidate: MintCandidate): ClaimKind | undefined {
  const fragment = claimFragment(candidate);
  if (!fragment || fragment.type !== "function") return undefined;
  const inputs = fragment.inputs ?? [];
  if (inputs.some((input) => input.type === "bytes32[]" || proofPattern.test(input.name ?? ""))) return "merkle";
  if (inputs.some((input) => input.type === "bytes" && signaturePattern.test(input.name ?? "signature")) || inputs.some((input) => signaturePattern.test(input.name ?? ""))) return "signature";
  return undefined;
}

function configuredClaimData(candidate: MintCandidate, kind: ClaimKind): ClaimData | undefined {
  const args = candidate.metadata.args;
  if (Array.isArray(args)) return { kind, args, source: "configured-args" };
  if (kind === "merkle" && Array.isArray(candidate.metadata.merkleProof)) {
    return { kind, args: candidate.metadata.merkleArgs as unknown[] ?? [candidate.metadata.merkleProof], source: "configured-merkle-proof" };
  }
  if (kind === "signature" && typeof candidate.metadata.signature === "string") {
    return { kind, args: candidate.metadata.signatureArgs as unknown[] ?? [candidate.metadata.signature], source: "configured-signature" };
  }
  return undefined;
}

export class HttpClaimDataProvider {
  constructor(private readonly endpoint: string, private readonly token?: string) {}
  async resolve(candidate: MintCandidate, kind: ClaimKind): Promise<ClaimData | undefined> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ chainKey: candidate.chainKey, contract: candidate.contract, wallet: candidate.from, mintFunction: candidate.mintFunction, kind, candidateId: candidate.id }),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { args?: unknown[]; proof?: unknown[]; signature?: string; typedData?: Record<string, unknown>; source?: string };
    const args = body.args ?? (kind === "merkle" ? body.proof : body.signature ? [body.signature] : undefined);
    if (!Array.isArray(args)) return undefined;
    return { kind, args, source: body.source ?? "claim-api", typedData: body.typedData };
  }
}

export class EvmClaimInspector implements ContractInspector {
  constructor(private readonly provider?: ClaimDataProvider) {}
  async inspect(candidate: MintCandidate): Promise<MintCandidate> {
    const kind = requiredClaimKind(candidate);
    if (!kind) return candidate;
    const configured = configuredClaimData(candidate, kind);
    const data = configured ?? (this.provider ? await this.provider(candidate, kind) : undefined);
    const eligibility = candidate.eligibility;
    if (!data) {
      return { ...candidate, eligible: false, metadata: { ...candidate.metadata, claimDataRequired: kind, claimDataAvailable: false }, eligibility: { ...eligibility, checkedAt: new Date().toISOString(), eligible: false, allowlistRequired: kind === "merkle", allowlistProofAvailable: false, reason: `${kind} claim data unavailable` } };
    }
    return { ...candidate, metadata: { ...candidate.metadata, args: data.args, claimDataRequired: kind, claimDataAvailable: true, claimDataSource: data.source, signatureRequired: kind === "signature", typedData: data.typedData ?? candidate.metadata.typedData }, eligibility: { ...eligibility, checkedAt: new Date().toISOString(), eligible: eligibility?.eligible !== false, allowlistRequired: kind === "merkle", allowlistProofAvailable: kind === "merkle" } };
  }
}

export function httpClaimProvider(endpoint?: string, token?: string): ClaimDataProvider | undefined {
  if (!endpoint) return undefined;
  const provider = new HttpClaimDataProvider(endpoint, token);
  return provider.resolve.bind(provider);
}

export function detectClaimRequirement(candidate: MintCandidate): ClaimKind | undefined { return requiredClaimKind(candidate); }

export type { ClaimData, ClaimKind };
