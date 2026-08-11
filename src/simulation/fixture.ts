import type { Simulator } from "../domain/ports";
import type { MintCandidate, SimulationResult } from "../domain/types";

export class FixtureSimulator implements Simulator {
  async simulate(candidate: MintCandidate): Promise<SimulationResult> {
    const metadata = candidate.metadata;
    if (!candidate.calldata) return { success: false, stateDiffAvailable: false, assetDiff: [], approvalDiff: [], revertReason: "missing calldata" };
    if (metadata.simulation === "revert") {
      return { success: false, stateDiffAvailable: true, assetDiff: [], approvalDiff: [], revertReason: String(metadata.revertReason ?? "execution reverted") };
    }
    const assetDiff = metadata.nftReceived === false ? [] : [{ kind: "nft" as const, direction: "in" as const, token: candidate.contract }];
    const approvalDiff = metadata.approval === true ? [{ token: String(metadata.approvalToken ?? candidate.contract) as `0x${string}`, spender: candidate.contract, amount: "unlimited" }] : [];
    const unexpectedCalls = metadata.unexpectedEthTransfer === true ? [{ to: candidate.contract, value: String(metadata.unexpectedEthAmount ?? "unknown") }] : [];
    const externalValueTransfers = metadata.unexpectedEthTransfer === true ? [{ asset: "native" as const, amount: String(metadata.unexpectedEthAmount ?? "unknown"), direction: "out" as const }] : [];
    const assetOut = metadata.erc20Fee === true ? [{ kind: "erc20" as const, direction: "out" as const, amount: String(metadata.erc20Amount ?? "unknown"), token: String(metadata.erc20Token ?? candidate.contract) as `0x${string}` }] : [];
    return {
      success: true,
      gasEstimate: BigInt(Number(metadata.gasEstimate ?? 250000)),
      gasPriceWei: BigInt(Number(metadata.gasPriceWei ?? 1000000000)),
      stateDiffAvailable: true,
      assetDiff: [...assetDiff, ...assetOut],
      approvalDiff,
      unexpectedCalls,
      externalValueTransfers,
    };
  }
}
