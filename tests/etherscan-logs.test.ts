import { afterEach, describe, expect, test } from "bun:test";
import { fetchLogsViaEtherscan } from "../src/discovery/rpc/etherscan-logs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(responses: object[]) {
  let call = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    urls.push(input.toString());
    const body = responses[Math.min(call, responses.length - 1)];
    call++;
    return { json: async () => body } as Response;
  }) as typeof fetch;
  return urls;
}

describe("fetchLogsViaEtherscan", () => {
  test("maps a single page of results into EtherscanLog objects", async () => {
    stubFetch([{ status: "1", message: "OK", result: [{ address: "0xabc", topics: ["0xtopic0"], data: "0x", blockNumber: "0x64" }] }]);
    const logs = await fetchLogsViaEtherscan({ apiKey: "key", chainId: 1 }, { topics: ["0xtopic0"], fromBlock: 1n, toBlock: 100n });
    expect(logs).toEqual([{ address: "0xabc", topics: ["0xtopic0"], data: "0x", blockNumber: 100n }]);
  });

  test("stops on a clean 'No records found' response instead of throwing", async () => {
    stubFetch([{ status: "0", message: "No records found", result: [] }]);
    const logs = await fetchLogsViaEtherscan({ apiKey: "key", chainId: 1 }, { topics: ["0xtopic0"], fromBlock: 1n, toBlock: 100n });
    expect(logs).toEqual([]);
  });

  test("throws on a real API error", async () => {
    stubFetch([{ status: "0", message: "Invalid API Key", result: [] }]);
    await expect(fetchLogsViaEtherscan({ apiKey: "bad", chainId: 1 }, { topics: ["0xtopic0"], fromBlock: 1n, toBlock: 100n })).rejects.toThrow("Invalid API Key");
  });

  test("paginates when a page returns a full page of results", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ address: "0xabc", topics: ["0xtopic0"], data: "0x", blockNumber: `0x${(100 + i).toString(16)}` }));
    const lastPage = [{ address: "0xdef", topics: ["0xtopic0"], data: "0x", blockNumber: "0x999" }];
    const urls = stubFetch([{ status: "1", message: "OK", result: fullPage }, { status: "1", message: "OK", result: lastPage }]);
    const logs = await fetchLogsViaEtherscan({ apiKey: "key", chainId: 1 }, { topics: ["0xtopic0"], fromBlock: 1n, toBlock: 100000n });
    expect(logs.length).toBe(1001);
    expect(urls[0]).toContain("page=1");
    expect(urls[1]).toContain("page=2");
  });

  test("builds the request URL with address, topics, and AND operators", async () => {
    const urls = stubFetch([{ status: "1", message: "OK", result: [] }]);
    await fetchLogsViaEtherscan(
      { apiKey: "mykey", chainId: 1 },
      { address: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5" as `0x${string}`, topics: ["0xtopic0", null, "0xtopic2"], fromBlock: 5n, toBlock: 10n },
    );
    const url = new URL(urls[0]);
    expect(url.searchParams.get("chainid")).toBe("1");
    expect(url.searchParams.get("module")).toBe("logs");
    expect(url.searchParams.get("action")).toBe("getLogs");
    expect(url.searchParams.get("address")).toBe("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
    expect(url.searchParams.get("topic0")).toBe("0xtopic0");
    expect(url.searchParams.get("topic2")).toBe("0xtopic2");
    expect(url.searchParams.get("topic1")).toBeNull();
    expect(url.searchParams.get("apikey")).toBe("mykey");
  });
});
