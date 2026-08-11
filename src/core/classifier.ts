import type { Classifier } from "../domain/ports";
import type { Classification, MintCandidate, SimulationResult } from "../domain/types";

export class RuleClassifier implements Classifier {
  async classify(candidate: MintCandidate, simulation?: SimulationResult): Promise<Classification> {
    const reasons: string[] = [];
    const metadata = candidate.metadata;
    const isNft = metadata.assetType === "nft" || simulation?.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "in") === true;
    const isMintOrClaim = Boolean(candidate.mintFunction || metadata.action === "mint" || metadata.action === "claim");
    const hasNativePayment = candidate.valueWei > 0n || metadata.paymentRequired === true;
    const hasErc20Fee = metadata.erc20Fee === true || simulation?.assetDiff.some((diff) => diff.kind === "erc20" && diff.direction === "out") === true;
    const hasNftBurn = metadata.burnRequired === true || simulation?.assetDiff.some((diff) => diff.kind === "nft" && diff.direction === "out") === true;
    const requiresSignature = metadata.signatureRequired === true;
    const paymentKind = hasNativePayment ? "native" : hasErc20Fee ? "erc20" : hasNftBurn ? "nft-burn" : requiresSignature ? "signature" : "none";
    const isFree = paymentKind === "none";
    const isActive = candidate.active !== false;
    const isEligible = candidate.eligible !== false;
    if (!isNft) reasons.push("not classified as NFT");
    if (!isMintOrClaim) reasons.push("no mint or claim action");
    if (!isFree) reasons.push(paymentKind === "native" ? "payment required" : `wallet state transition requires ${paymentKind}`);
    if (!isActive) reasons.push("inactive");
    if (!isEligible) reasons.push("wallet not eligible");
    return { isNft, isMintOrClaim, isFree, isActive, isEligible, paymentKind, reasons };
  }
}
