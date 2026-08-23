import { keccak256, type Hex } from "viem";

/**
 * Fires an already-signed raw transaction at several RPC endpoints simultaneously instead
 * of just one, so whichever provider is fastest (or least congested) at that exact moment
 * gets it into a block — the same trick every serious public-mint sniper uses (confirmed
 * directly in morsyxbt/nft-public-mint's rpc-blast.ts). Computing the tx hash locally
 * (rather than waiting for a provider to echo it back) means the caller can log/track it
 * immediately, before any network round trip completes.
 */

export type PreparedBlast = { txHash: Hex; body: string };
export type BlastResult = { rpcUrl: string; txHash: Hex | null; error: string | null };

/** Precomputes everything that doesn't need the network — call this once, right after signing, well before the actual fire moment. */
export function prepareBlast(rawTx: Hex): PreparedBlast {
  return {
    txHash: keccak256(rawTx),
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [rawTx], id: 1 }),
  };
}

/** Sends the prepared transaction to every RPC endpoint at once and returns immediately (dispatch is fire-and-forget) — await the returned promise separately to find out which endpoints actually accepted it. */
export function blastToAll(prepared: PreparedBlast, rpcUrls: string[]): { txHash: Hex; results: Promise<BlastResult[]> } {
  const attempts = rpcUrls.map(async (rpcUrl): Promise<BlastResult> => {
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: prepared.body });
      const json = (await response.json()) as { result?: Hex; error?: { message?: string } };
      if (json.result) return { rpcUrl, txHash: json.result, error: null };
      const message = json.error?.message ?? "unknown error";
      // "already known" just means a faster endpoint already relayed the same tx to the mempool — a success signal, not a failure.
      return { rpcUrl, txHash: message.includes("already known") ? prepared.txHash : null, error: message.includes("already known") ? null : message };
    } catch (error) {
      return { rpcUrl, txHash: null, error: (error as Error).message };
    }
  });
  return { txHash: prepared.txHash, results: Promise.all(attempts) };
}

/** Polls for a receipt until it appears or the timeout elapses. Returns undefined on timeout, not an error — the tx may still land later; the caller decides how to handle "unknown yet". */
export async function waitForReceipt(rpcUrl: string, txHash: Hex, timeoutMs: number, pollMs = 1000): Promise<{ blockNumber: bigint; status: "success" | "reverted"; gasUsed: bigint } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [txHash], id: 1 }) });
    const json = (await response.json()) as { result?: { blockNumber: Hex; status: Hex; gasUsed: Hex } | null };
    if (json.result) return { blockNumber: BigInt(json.result.blockNumber), status: json.result.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(json.result.gasUsed) };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return undefined;
}
