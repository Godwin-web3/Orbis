import type { CalldataBuilder, Classifier, OpportunityEngine } from "../../domain/ports";
import type { MintCandidate, SimulationResult, TransactionRequest } from "../../domain/types";
import type { OpportunityStrategy, StrategyEvaluation } from "../types";

export class NftFreeMintStrategy implements OpportunityStrategy {
  readonly name = "nft-free-mint";
  constructor(private readonly calldata: CalldataBuilder, private readonly classifier: Classifier, private readonly opportunities: OpportunityEngine) {}
  supports(candidate: MintCandidate): boolean { return candidate.metadata.assetType === "nft" || candidate.mintFunction === "mint" || candidate.mintFunction === "claim" || candidate.mintFunction === "freeMint"; }
  async buildTransaction(candidate: MintCandidate): Promise<TransactionRequest> { return this.calldata.build(candidate); }
  async evaluate(candidate: MintCandidate, simulation: SimulationResult): Promise<StrategyEvaluation> {
    const transaction = await this.buildTransaction(candidate);
    const classification = await this.classifier.classify(candidate, simulation);
    const opportunity = await this.opportunities.score(candidate, classification, simulation);
    return { strategy: this.name, candidate, classification, simulation, opportunity, transaction };
  }
}
