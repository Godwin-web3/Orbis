import type { PolicyEngine } from "../domain/ports";
import type { MintCandidate, Opportunity, SimulationResult } from "../domain/types";

function num(metadata: MintCandidate["metadata"], key: string): number {
  const value = Number(metadata[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function requiresValueSignal(): boolean {
  return (process.env.REQUIRE_VALUE_SIGNAL ?? "on") !== "off";
}

/** A drop is worth showing only if someone would pay for it or people are actually minting it. */
export function hasValueSignal(candidate: MintCandidate): boolean {
  if (candidate.metadata.valueSignal === true) return true;
  const minFloor = Number(process.env.MIN_FLOOR_NATIVE ?? "0.002");
  const minMints = Number(process.env.MIN_RECENT_MINTS ?? "3");
  const minVolume = Number(process.env.MIN_VOLUME_NATIVE ?? "0.05");
  const minScore = Number(process.env.MIN_VALUE_SCORE ?? "20");
  return num(candidate.metadata, "floorNative") >= minFloor
    || num(candidate.metadata, "estimatedValueNative") >= minFloor
    || num(candidate.metadata, "recentMints") >= minMints
    || num(candidate.metadata, "volumeAllTimeNative") >= minVolume
    || num(candidate.metadata, "valueScore") >= minScore;
}

export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(opportunity: Opportunity, simulation: SimulationResult) {
    const reasons: string[] = [];
    const maxGas = Number(process.env.MAX_GAS_NATIVE ?? "0.005");
    const minExpectedValue = Number(process.env.MIN_EXPECTED_VALUE_NATIVE ?? "0");
    if (opportunity.classification.reasons.length) reasons.push(...opportunity.classification.reasons);
    if (!simulation.success) reasons.push(simulation.revertReason ?? "simulation failed");
    if (simulation.approvalDiff.length) reasons.push("simulation produced token approval");
    if (simulation.unexpectedCalls?.length || simulation.externalValueTransfers?.some((transfer) => transfer.direction === "out")) reasons.push("simulation produced unexpected external value transfer");
    // The trace-based NFT-receipt check needs debug_traceCall, which free/public RPC
    // providers commonly don't support — see simulation/rpc.ts. SeaDrop candidates already
    // carry independent proof (getPublicDrop read directly against the known, audited
    // SeaDrop singleton before ever being surfaced — see discovery/rpc/seadrop-source.ts),
    // so a successful, non-reverting simulation is sufficient evidence for those without
    // also requiring a trace. Every other source still needs the trace-based check, since
    // it has no other way to know an arbitrary contract is legitimate.
    if (!opportunity.candidate.metadata.seadrop && !simulation.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "in")) reasons.push("simulation did not show NFT receipt");
    if (opportunity.gasNative > maxGas) reasons.push(`gas exceeds ${maxGas} native token limit`);
    // Only judge expected value when a real floor-derived estimate exists (> 0). Demand-only
    // drops have estimatedValueNative = 0 and must not be vetoed by -gas.
    const estimate = Number(opportunity.candidate.metadata.estimatedValueNative);
    const hasValueEstimate = Number.isFinite(estimate) && estimate > 0;
    if (hasValueEstimate && opportunity.expectedValueNative <= minExpectedValue) reasons.push("expected value is below configured threshold");
    if (requiresValueSignal() && !hasValueSignal(opportunity.candidate)) reasons.push("no demand or floor — likely worthless");
    return { allowed: reasons.length === 0, reasons };
  }
}
