import { afterEach, describe, expect, test } from "bun:test";
import { blastToAll, prepareBlast, waitForReceipt } from "../src/execution/rpc-blast";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const RAW_TX = "0x02f86f0102830f4240830f4240830f424094000000000000000000000000000000000000000180840123456780c001a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;

describe("prepareBlast", () => {
  test("computes the tx hash locally without any network call", () => {
    const prepared = prepareBlast(RAW_TX);
    expect(prepared.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.body).toContain("eth_sendRawTransaction");
    expect(prepared.body).toContain(RAW_TX);
  });
  test("the same raw tx always hashes the same", () => {
    expect(prepareBlast(RAW_TX).txHash).toBe(prepareBlast(RAW_TX).txHash);
  });
});

describe("blastToAll", () => {
  test("sends to every endpoint and reports which ones accepted it", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return { json: async () => ({ result: "0xabc123" }) } as Response;
    }) as typeof fetch;

    const prepared = prepareBlast(RAW_TX);
    const { txHash, results } = blastToAll(prepared, ["https://rpc-a.example", "https://rpc-b.example"]);
    expect(txHash).toBe(prepared.txHash); // returned immediately, computed locally
    expect(calls).toEqual(["https://rpc-a.example", "https://rpc-b.example"]); // dispatched to both without waiting

    const settled = await results;
    expect(settled).toHaveLength(2);
    expect(settled.every((r) => r.txHash === "0xabc123" && r.error === null)).toBe(true);
  });

  test("treats 'already known' as a success signal, not a failure", async () => {
    globalThis.fetch = (async (_url: string) => ({ json: async () => ({ error: { message: "already known" } }) } as Response)) as typeof fetch;
    const { results } = blastToAll(prepareBlast(RAW_TX), ["https://rpc-a.example"]);
    const [result] = await results;
    expect(result.error).toBeNull();
    expect(result.txHash).not.toBeNull();
  });

  test("reports a real rejection as an error with no tx hash", async () => {
    globalThis.fetch = (async (_url: string) => ({ json: async () => ({ error: { message: "max fee per gas less than block base fee" } }) } as Response)) as typeof fetch;
    const { results } = blastToAll(prepareBlast(RAW_TX), ["https://rpc-a.example"]);
    const [result] = await results;
    expect(result.error).toBe("max fee per gas less than block base fee");
    expect(result.txHash).toBeNull();
  });

  test("one endpoint throwing (network error) doesn't affect the others", async () => {
    let call = 0;
    globalThis.fetch = (async (_url: string) => {
      call++;
      if (call === 1) throw new Error("connection refused");
      return { json: async () => ({ result: "0xabc123" }) } as Response;
    }) as typeof fetch;
    const { results } = blastToAll(prepareBlast(RAW_TX), ["https://rpc-a.example", "https://rpc-b.example"]);
    const settled = await results;
    expect(settled.find((r) => r.error === "connection refused")).toBeDefined();
    expect(settled.find((r) => r.txHash === "0xabc123")).toBeDefined();
  });
});

describe("waitForReceipt", () => {
  test("returns the receipt once one appears", async () => {
    let call = 0;
    globalThis.fetch = (async (_url: string) => {
      call++;
      const result = call < 2 ? null : { blockNumber: "0x64", status: "0x1", gasUsed: "0x5208" };
      return { json: async () => ({ result }) } as Response;
    }) as typeof fetch;
    const receipt = await waitForReceipt("https://rpc-a.example", "0xabc" as `0x${string}`, 5000, 1);
    expect(receipt).toEqual({ blockNumber: 100n, status: "success", gasUsed: 21000n });
  });

  test("reports a reverted tx as such", async () => {
    globalThis.fetch = (async (_url: string) => ({ json: async () => ({ result: { blockNumber: "0x64", status: "0x0", gasUsed: "0x5208" } }) } as Response)) as typeof fetch;
    const receipt = await waitForReceipt("https://rpc-a.example", "0xabc" as `0x${string}`, 5000, 1);
    expect(receipt?.status).toBe("reverted");
  });

  test("returns undefined on timeout rather than throwing", async () => {
    globalThis.fetch = (async (_url: string) => ({ json: async () => ({ result: null }) } as Response)) as typeof fetch;
    const receipt = await waitForReceipt("https://rpc-a.example", "0xabc" as `0x${string}`, 5, 1);
    expect(receipt).toBeUndefined();
  });
});
