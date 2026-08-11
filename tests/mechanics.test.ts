import { describe, expect, test } from "bun:test";
import { encodeFunctionData, type Abi } from "viem";
import { buildMintCalldata } from "../src/discovery/contract/detector";
import { detectClaimRequirement } from "../src/discovery/contract/claims";
import { validatePreparedTransaction } from "../src/execution/tx-safety";

describe("real mint mechanics", () => {
  test("builds custom ABI calldata with configured arguments", () => {
    const abi = [{ type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "recipient", type: "address" }, { name: "quantity", type: "uint256" }], outputs: [] }] as const satisfies Abi;
    const candidate = { id: "custom", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "claim", valueWei: 0n, metadata: { abi, args: ["0x0000000000000000000000000000000000000002", 1n] } };
    expect(buildMintCalldata(candidate)).toBe(encodeFunctionData({ abi, functionName: "claim", args: ["0x0000000000000000000000000000000000000002", 1n] }));
  });

  test("detects Merkle and signature claim requirements", () => {
    const base = { id: "claim", chainKey: "base", contract: "0x0000000000000000000000000000000000000001" as `0x${string}`, source: "test", discoveredAt: new Date().toISOString(), mintFunction: "claim", valueWei: 0n, metadata: {} };
    expect(detectClaimRequirement({ ...base, metadata: { abi: [{ type: "function", name: "claim", inputs: [{ name: "proof", type: "bytes32[]" }], outputs: [] }] } })).toBe("merkle");
    expect(detectClaimRequirement({ ...base, metadata: { abi: [{ type: "function", name: "claim", inputs: [{ name: "signature", type: "bytes" }], outputs: [] }] } })).toBe("signature");
  });

  test("prepared transaction safety rejects non-pass records", () => {
    const reasons = validatePreparedTransaction({ chainKey: "base", to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: 0n, chainId: 8453, gas: 100000n, gasPriceWei: 1000000000n, simulationMode: "trace", policy: "REJECT", reasons: [], preparedAt: new Date().toISOString() });
    expect(reasons).toContain("transaction policy is REJECT");
    expect(reasons).toContain("missing sender wallet");
  });
});
