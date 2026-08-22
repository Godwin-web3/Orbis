import type { PolicyEngine } from "../domain/ports";
import type { Opportunity, SimulationResult } from "../domain/types";

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
    if (opportunity.expectedValueNative <= minExpectedValue) reasons.push("expected value is below configured threshold");
    return { allowed: reasons.length === 0, reasons };
  }
}
