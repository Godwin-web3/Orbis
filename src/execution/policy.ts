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
    if (!simulation.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "in")) reasons.push("simulation did not show NFT receipt");
    if (opportunity.gasNative > maxGas) reasons.push(`gas exceeds ${maxGas} native token limit`);
    if (opportunity.expectedValueNative <= minExpectedValue) reasons.push("expected value is below configured threshold");
    return { allowed: reasons.length === 0, reasons };
  }
}
