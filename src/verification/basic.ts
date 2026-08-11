import type { Verifier } from "../domain/ports";
import type { MintCandidate } from "../domain/types";

export class BasicVerifier implements Verifier {
  async verify(_txHash: `0x${string}`, _candidate: MintCandidate) { return { success: true, ownerConfirmed: false }; }
}
