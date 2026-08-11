import type { Classification, MintCandidate, Opportunity, SimulationResult, TransactionRequest } from "../domain/types";

export type StrategyEvaluation = {
  strategy: string;
  candidate: MintCandidate;
  classification: Classification;
  simulation: SimulationResult;
  opportunity: Opportunity;
  transaction: TransactionRequest;
};

export interface OpportunityStrategy {
  readonly name: string;
  supports(candidate: MintCandidate): boolean;
  buildTransaction(candidate: MintCandidate): Promise<TransactionRequest>;
  evaluate(candidate: MintCandidate, simulation: SimulationResult): Promise<StrategyEvaluation>;
}
