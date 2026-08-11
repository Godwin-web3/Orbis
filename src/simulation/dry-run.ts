import type { Simulator } from "../domain/ports";
import type { MintCandidate, SimulationResult } from "../domain/types";

export class ConservativeSimulator implements Simulator {
  async simulate(candidate: MintCandidate): Promise<SimulationResult> {
    if (!candidate.calldata) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "missing calldata" };
    const metadata = candidate.metadata;
    if (metadata.simulation === "revert") return { success: false, stateDiffAvailable: true, assetDiff: [], approvalDiff: [], revertReason: String(metadata.revertReason ?? "simulated revert") };
    const assetDiff = [{ kind: "nft" as const, direction: "in" as const, token: candidate.contract }];
    const approvalDiff = metadata.approval === true ? [{ token: candidate.contract, spender: candidate.contract, amount: "max" }] : [];
    const unexpectedCalls = metadata.unexpectedEthTransfer === true ? [{ to: candidate.contract, value: "1" }] : [];
    return {
      success: true,
      gasEstimate: BigInt(String(metadata.gasEstimate ?? 250000)),
      gasPriceWei: BigInt(String(metadata.gasPriceWei ?? 1000000000)),
      stateDiffAvailable: true,
      assetDiff,
      approvalDiff,
      unexpectedCalls,
    };
  }
}
