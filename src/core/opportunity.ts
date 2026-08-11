import type { OpportunityEngine } from "../domain/ports";
import type { Classification, MintCandidate, Opportunity, SimulationResult } from "../domain/types";

function boundedProbability(value: unknown, fallback: number): number {
  const probability = Number(value ?? fallback);
  return Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : fallback;
}

export class DefaultOpportunityEngine implements OpportunityEngine {
  async score(candidate: MintCandidate, classification: Classification, simulation: SimulationResult): Promise<Opportunity> {
    const probability = classification.reasons.length === 0 && simulation.success ? boundedProbability(candidate.metadata.successProbability, 0.55) : 0;
    const estimatedValueNative = Math.max(0, Number(candidate.metadata.estimatedValueNative ?? 0));
    const gasNative = simulation.gasEstimate && simulation.gasPriceWei ? Number(simulation.gasEstimate * simulation.gasPriceWei) / 1e18 : 0;
    const executionRisk = simulation.approvalDiff.length || simulation.unexpectedCalls?.length || simulation.externalValueTransfers?.some((transfer) => transfer.direction === "out") ? 1 : 0.1;
    const expectedValueNative = probability * estimatedValueNative - gasNative - executionRisk * 0.001;
    return { candidate, classification, probability, estimatedValueNative, gasNative, executionRisk, expectedValueNative, priority: expectedValueNative };
  }
}
