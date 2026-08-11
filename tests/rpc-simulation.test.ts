import { describe, expect, test } from "bun:test";
import { RpcSimulator, RpcTransportPool } from "../src/simulation/rpc";
import type { MintCandidate } from "../src/domain/types";

const wallet = "0x00000000000000000000000000000000000000aa" as const;
const contract = "0x00000000000000000000000000000000000000bb" as const;
const token = "0x00000000000000000000000000000000000000cc" as const;
const spender = "0x00000000000000000000000000000000000000dd" as const;
const word = (address: string) => address.slice(2).padStart(64, "0");
const transferLog = { address: token, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${word("0x0000000000000000000000000000000000000000")}`, `0x${word(wallet)}`, `0x${word("0x0000000000000000000000000000000000000001")}`], data: "0x" };
const approvalInput = `0x095ea7b3${word(spender)}${"f".repeat(64)}`;
const candidate: MintCandidate = { id: "rpc-fixture", chainKey: "base", contract, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "freeMint", calldata: "0x1234", valueWei: 0n, from: wallet, metadata: { assetType: "nft" } };

describe("RPC simulator", () => {
  test("extracts NFT receipt and approval from call trace", async () => {
    const calls = { type: "CALL", from: wallet, to: contract, value: "0x0", input: "0x1234", calls: [{ type: "CALL", from: wallet, to: token, value: "0x0", input: approvalInput }, { type: "CALL", from: contract, to: token, value: "0x0", input: "0x", logs: [transferLog] }] };
    const requests: string[] = [];
    const rpc = async (method: string) => {
      requests.push(method);
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "debug_traceCall") return calls;
      return "0x";
    };
    const result = await new RpcSimulator({}, { base: rpc }).simulate(candidate);
    expect(result.success).toBe(true);
    expect(result.stateDiffAvailable).toBe(true);
    expect(result.assetDiff).toHaveLength(1);
    expect(result.assetDiff[0]?.kind).toBe("nft");
    expect(result.approvalDiff).toHaveLength(1);
    expect(result.approvalDiff[0]?.amount).toBe("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    expect(requests).toContain("debug_traceCall");
  });

  test("falls back to a healthy provider", async () => {
    const pool = new RpcTransportPool([async () => { throw new Error("down"); }, async () => "ok"]);
    await expect(pool.request("eth_blockNumber", [])).resolves.toBe("ok");
  });
});
