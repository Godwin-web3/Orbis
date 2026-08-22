import { describe, expect, test } from "bun:test";
import { encodeFunctionData, type PublicClient } from "viem";
import { BlockContractDiscoverySource } from "../src/discovery/rpc/block-source";
import type { BlockCursorStore } from "../src/discovery/rpc/block-cursor";

const MINT_SELECTOR = encodeFunctionData({
  abi: [{ type: "function", name: "mint", stateMutability: "payable", inputs: [], outputs: [] }],
  functionName: "mint",
}).slice(2, 10);
const MINT_BYTECODE = `0x${"00".repeat(10)}${MINT_SELECTOR}${"00".repeat(10)}` as `0x${string}`;

function memCursor(): BlockCursorStore {
  const store = new Map<string, bigint>();
  return {
    get: async (chainKey) => store.get(chainKey),
    set: async (chainKey, block) => { store.set(chainKey, block); },
  };
}

function fakeClient(opts: { latest: bigint; logAddresses?: `0x${string}`[]; getLogsShouldThrowOnce?: boolean }): PublicClient {
  let threw = false;
  return {
    getBlockNumber: async () => opts.latest,
    getLogs: async ({ toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (opts.getLogsShouldThrowOnce && !threw) { threw = true; throw new Error("range too large"); }
      return (opts.logAddresses ?? []).map((address) => ({ address, blockNumber: toBlock }));
    },
    getBytecode: async () => MINT_BYTECODE,
  } as unknown as PublicClient;
}

describe("BlockContractDiscoverySource", () => {
  test("finds a candidate from a Transfer-from-zero log and advances the cursor", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const client = fakeClient({ latest: 1000n, logAddresses: [contract] });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });

    const candidates = await source.discover();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].contract).toBe(contract);
    expect(candidates[0].mintFunction).toBe("mint");
    expect(await cursor.get("base")).toBe(998n); // safeLatest = latest - confirmations
  });

  test("second scan resumes from cursor + 1, not the fixed recent window", async () => {
    const cursor = memCursor();
    await cursor.set("base", 500n);
    const client = fakeClient({ latest: 1000n, logAddresses: [] });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });

    let capturedFrom: bigint | undefined;
    const spyClient = {
      ...client,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => { capturedFrom = fromBlock; return []; },
    } as unknown as PublicClient;
    const spySource = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client: spyClient, cursor, confirmations: 2n });
    await spySource.discover();
    expect(capturedFrom).toBe(501n);
  });

  test("no candidate when bytecode has no recognizable mint function", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000002" as `0x${string}`;
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => [{ address: contract, blockNumber: 998n }],
      getBytecode: async () => "0x00" as `0x${string}`,
    } as unknown as PublicClient;
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("retries with a smaller range if the provider rejects the first request", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000003" as `0x${string}`;
    const client = fakeClient({ latest: 1000n, logAddresses: [contract], getLogsShouldThrowOnce: true });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    const candidates = await source.discover();
    expect(candidates.length).toBeGreaterThan(0);
  });

  test("returns nothing once caught up (fromBlock past safeLatest)", async () => {
    const cursor = memCursor();
    await cursor.set("base", 999n);
    const client = fakeClient({ latest: 1000n, logAddresses: [] });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });
});
