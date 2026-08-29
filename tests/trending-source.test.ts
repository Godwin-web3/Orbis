import { afterEach, describe, expect, test } from "bun:test";
import { encodeFunctionData, type PublicClient } from "viem";
import { TrendingMintDiscoverySource } from "../src/discovery/heat/source";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const MINT_SELECTOR = encodeFunctionData({
  abi: [{ type: "function", name: "mint", stateMutability: "payable", inputs: [], outputs: [] }],
  functionName: "mint",
}).slice(2, 10);
const MINT_BYTECODE = `0x${"00".repeat(10)}${MINT_SELECTOR}${"00".repeat(10)}` as `0x${string}`;

function stubTrending(mints: object[]) {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ mints }) })) as unknown as typeof fetch;
}

describe("TrendingMintDiscoverySource", () => {
  test("no-ops on a chain Reservoir doesn't cover (Robinhood)", async () => {
    stubTrending([{ mintCount: 999, collection: { id: "0x00000000000000000000000000000000000000aa" } }]);
    const source = new TrendingMintDiscoverySource({ chainKey: "robinhood", rpcUrls: [], client: { getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient });
    expect(await source.discover()).toEqual([]);
  });

  test("drops a trending row below the real-runner mint threshold", async () => {
    stubTrending([{ mintCount: 2, collection: { id: "0x00000000000000000000000000000000000000aa", name: "Meh Drop" } }]);
    const source = new TrendingMintDiscoverySource({ chainKey: "ethereum", rpcUrls: [], minRecentMints: 5, client: { getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient });
    expect(await source.discover()).toEqual([]);
  });

  test("surfaces a real runner with recentMints/floor/name carried onto the candidate", async () => {
    stubTrending([{
      mintCount: 40,
      uniqueMinters: 30,
      collection: { id: "0x00000000000000000000000000000000000000aa", name: "Hot Drop", floorAsk: { price: { amount: { native: 0.03 } } } },
    }]);
    const source = new TrendingMintDiscoverySource({ chainKey: "ethereum", rpcUrls: [], minRecentMints: 5, client: { getBytecode: async () => MINT_BYTECODE } as unknown as PublicClient });
    const candidates = await source.discover();
    expect(candidates.length).toBe(1);
    expect(candidates[0].source).toBe("trending");
    expect(candidates[0].mintFunction).toBe("mint");
    expect(candidates[0].metadata.name).toBe("Hot Drop");
    expect(candidates[0].metadata.recentMints).toBe(40);
    expect(candidates[0].metadata.uniqueMinters).toBe(30);
    expect(candidates[0].metadata.floorNative).toBe(0.03);
  });

  test("skips a runner whose contract has no bytecode (not actually a contract, or RPC gap)", async () => {
    stubTrending([{ mintCount: 40, collection: { id: "0x00000000000000000000000000000000000000aa" } }]);
    const source = new TrendingMintDiscoverySource({ chainKey: "ethereum", rpcUrls: [], minRecentMints: 5, client: { getBytecode: async () => undefined } as unknown as PublicClient });
    expect(await source.discover()).toEqual([]);
  });
});
