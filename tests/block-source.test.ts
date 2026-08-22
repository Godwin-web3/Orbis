import { afterEach, describe, expect, test } from "bun:test";
import { encodeFunctionData, type PublicClient } from "viem";
import { BlockContractDiscoverySource } from "../src/discovery/rpc/block-source";
import type { BlockCursorStore } from "../src/discovery/rpc/block-cursor";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function stubEtherscanFetch(result: object[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(input.toString());
    return { json: async () => ({ status: "1", message: "OK", result }) } as Response;
  }) as typeof fetch;
  return calls;
}

const MINT_SELECTOR = encodeFunctionData({
  abi: [{ type: "function", name: "mint", stateMutability: "payable", inputs: [], outputs: [] }],
  functionName: "mint",
}).slice(2, 10);
const MINT_BYTECODE = `0x${"00".repeat(10)}${MINT_SELECTOR}${"00".repeat(10)}` as `0x${string}`;

// ERC-721 Transfer: tokenId indexed -> 4 topics (topic0 + 3 indexed args), empty data.
const ERC721_TOPICS = ["0xTransferSig", "0xfromZero", "0xto", "0xtokenId"];
// ERC-20 Transfer: same topic0, but value is NOT indexed -> only 3 topics, value in data.
const ERC20_TOPICS = ["0xTransferSig", "0xfromZero", "0xto"];

function memCursor(): BlockCursorStore {
  const store = new Map<string, bigint>();
  return {
    get: async (chainKey) => store.get(chainKey),
    set: async (chainKey, block) => { store.set(chainKey, block); },
  };
}

function fakeClient(opts: { latest: bigint; logAddresses?: `0x${string}`[]; topics?: string[]; getLogsShouldThrowOnce?: boolean; getLogsAlwaysThrows?: boolean; blockTransactions?: unknown[]; receipts?: Record<string, { contractAddress?: `0x${string}` }> }): PublicClient {
  let threw = false;
  return {
    getBlockNumber: async () => opts.latest,
    getLogs: async ({ toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (opts.getLogsAlwaysThrows) throw new Error("Please specify an address in your request");
      if (opts.getLogsShouldThrowOnce && !threw) { threw = true; throw new Error("range too large"); }
      return (opts.logAddresses ?? []).map((address) => ({ address, blockNumber: toBlock, topics: opts.topics ?? ERC721_TOPICS, data: "0x" }));
    },
    getBlock: async () => ({ transactions: opts.blockTransactions ?? [] }),
    getTransactionReceipt: async ({ hash }: { hash: string }) => opts.receipts?.[hash] ?? {},
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

  test("ignores ERC-20 Transfer events (same topic0, but tokenId not indexed)", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000009" as `0x${string}`;
    const client = fakeClient({ latest: 1000n, logAddresses: [contract], topics: ERC20_TOPICS });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("second scan resumes from cursor + 1, not the fixed recent window", async () => {
    const cursor = memCursor();
    await cursor.set("base", 500n);
    const client = fakeClient({ latest: 1000n, logAddresses: [] });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });

    let capturedFrom: bigint | undefined;
    const spyClient = {
      ...client,
      getLogs: async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => { capturedFrom = fromBlock; return []; },
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
      getLogs: async () => [{ address: contract, blockNumber: 998n, topics: ERC721_TOPICS, data: "0x" }],
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

  test("falls back to a new-contract scan when the provider refuses address-less getLogs entirely", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000005" as `0x${string}`;
    const client = fakeClient({
      latest: 1000n,
      getLogsAlwaysThrows: true,
      blockTransactions: [{ hash: "0xabc", to: null }],
      receipts: { "0xabc": { contractAddress: contract } },
    });
    const source = new BlockContractDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    const candidates = await source.discover();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].contract).toBe(contract);
  });

  test("returns nothing once caught up (fromBlock past safeLatest)", async () => {
    const cursor = memCursor();
    await cursor.set("base", 999n);
    const client = fakeClient({ latest: 1000n, logAddresses: [] });
    const source = new BlockContractDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("uses Etherscan instead of raw getLogs when configured, and widens the block range", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000007" as `0x${string}`;
    const calls = stubEtherscanFetch([{ address: contract, topics: ERC721_TOPICS, data: "0x", blockNumber: "0x3e8" }]);
    const client = { getBlockNumber: async () => 10000n, getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient;
    const source = new BlockContractDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n, etherscan: { apiKey: "key", chainId: 1 } });

    const candidates = await source.discover();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].contract).toBe(contract);
    const url = new URL(calls[0]);
    // No cursor yet, so fromBlock is the fixed 20-block default lookback (safeLatest=9998); the
    // 5000-block Etherscan range only matters once a cursor exists and there's real ground to cover.
    expect(url.searchParams.get("fromBlock")).toBe("9978");
    expect(url.searchParams.get("toBlock")).toBe("9998");
  });

  test("with a cursor already behind, Etherscan covers the full 5000-block range in one call", async () => {
    const cursor = memCursor();
    await cursor.set("ethereum", 1000n);
    const contract = "0x0000000000000000000000000000000000000009" as `0x${string}`;
    const calls = stubEtherscanFetch([{ address: contract, topics: ERC721_TOPICS, data: "0x", blockNumber: "0x3e8" }]);
    const client = { getBlockNumber: async () => 10000n, getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient;
    const source = new BlockContractDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n, etherscan: { apiKey: "key", chainId: 1 } });
    await source.discover();
    const url = new URL(calls[0]);
    expect(url.searchParams.get("fromBlock")).toBe("1001");
    expect(url.searchParams.get("toBlock")).toBe("6000");
  });

  test("still filters out ERC-20 Transfer logs when using Etherscan", async () => {
    const cursor = memCursor();
    const contract = "0x0000000000000000000000000000000000000008" as `0x${string}`;
    stubEtherscanFetch([{ address: contract, topics: ERC20_TOPICS, data: "0x", blockNumber: "0x3e8" }]);
    const client = { getBlockNumber: async () => 10000n, getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient;
    const source = new BlockContractDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n, etherscan: { apiKey: "key", chainId: 1 } });
    expect(await source.discover()).toEqual([]);
  });
});
