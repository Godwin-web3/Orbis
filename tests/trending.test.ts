import { describe, expect, test } from "bun:test";
import { fetchTrendingFreeMints } from "../src/discovery/heat/trending";
import { formatCookAlert } from "../src/telegram/bot";
import type { PreparedTransaction } from "../src/domain/types";

describe("fetchTrendingFreeMints", () => {
  test("returns empty for Robinhood — Reservoir does not index it", async () => {
    expect(await fetchTrendingFreeMints("robinhood")).toEqual([]);
  });

  test("parses Reservoir trending-mints rows", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        mints: [{
          mintCount: 22,
          uniqueMinters: 14,
          collection: {
            id: "0x00000000000000000000000000000000000000aa",
            name: "Hot Drop",
            floorAsk: { price: { amount: { native: 0.03 } } },
          },
        }],
      }),
    })) as unknown as typeof fetch;
    const rows = await fetchTrendingFreeMints("ethereum", { fetchImpl });
    expect(rows).toEqual([{
      contract: "0x00000000000000000000000000000000000000aa",
      name: "Hot Drop",
      mintCount: 22,
      uniqueMinters: 14,
      floorNative: 0.03,
    }]);
  });
});

describe("formatCookAlert", () => {
  test("is a short cooking ping, not a command dump", () => {
    const tx: PreparedTransaction = {
      chainKey: "ethereum",
      chainId: 1,
      to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
      data: "0x01",
      value: 0n,
      gas: 100000n,
      gasPriceWei: 1000000000n,
      simulationMode: "eth_call",
      policy: "PASS",
      reasons: [],
      preparedAt: "2026-08-25T00:00:00.000Z",
      mintFunction: "mintPublic",
      nftContract: "0x00000000000000000000000000000000000000aa",
      name: "Hot Drop",
      recentMints: 22,
      floorNative: 0.03,
    };
    const out = formatCookAlert(tx);
    expect(out).toContain("COOKING · Ethereum");
    expect(out).toContain("Hot Drop");
    expect(out).toContain("22 mints this window");
    expect(out).toContain("/mint 0");
    expect(out).not.toContain("/upcoming");
  });
});
