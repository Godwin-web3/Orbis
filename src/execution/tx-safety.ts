import type { PreparedTransaction } from "../domain/types";

export function validatePreparedTransaction(transaction: PreparedTransaction): string[] {
  const reasons: string[] = [];
  if (transaction.policy !== "PASS") reasons.push(`transaction policy is ${transaction.policy}`);
  if (!transaction.from) reasons.push("missing sender wallet");
  if (!transaction.data || transaction.data === "0x") reasons.push("missing calldata");
  if (transaction.gas <= 0n) reasons.push("invalid gas limit");
  if (transaction.gasPriceWei <= 0n) reasons.push("invalid gas price");
  return reasons;
}
