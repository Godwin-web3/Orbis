import { describe, expect, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import { SEADROP_ADDRESS, SeaDropDiscoverySource } from "../src/discovery/rpc/seadrop-source";
import type { BlockCursorStore } from "../src/discovery/rpc/block-cursor";
import type { ContractRegistry } from "../src/discovery/rpc/contract-registry";

const CONTRACT_A = "0x0000000000000000000000000000000000000010" as `0x${string}`;
const CONTRACT_B = "0x0000000000000000000000000000000000000020" as `0x${string}`;
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719" as `0x${string}`;

type PublicDrop = {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
};

function freeOpenDrop(overrides: Partial<PublicDrop> = {}): PublicDrop {
  const now = Math.floor(Date.now() / 1000);
  return { mintPrice: 0n, startTime: now - 3600, endTime: now + 3600, maxTotalMintableByWallet: 5, feeBps: 500, restrictFeeRecipients: false, ...overrides };
}

const UNSET_DROP: PublicDrop = { mintPrice: 0n, startTime: 0, endTime: 0, maxTotalMintableByWallet: 0, feeBps: 0, restrictFeeRecipients: false };

function memCursor(): BlockCursorStore {
  const store = new Map<string, bigint>();
  return {
    get: async (chainKey) => store.get(chainKey),
    set: async (chainKey, block) => { store.set(chainKey, block); },
  };
}

function memRegistry(seed: Record<string, Address[]> = {}): ContractRegistry {
  const store = new Map<string, Address[]>(Object.entries(seed));
  return {
    list: async (key) => store.get(key) ?? [],
    add: async (key, contract) => {
      const existing = store.get(key) ?? [];
      if (!existing.includes(contract)) store.set(key, [...existing, contract]);
    },
  };
}

function fakeClient(opts: {
  latest: bigint;
  mintedContracts?: `0x${string}`[];
  drops?: Record<string, PublicDrop>;
  allowedFeeRecipients?: Record<string, `0x${string}`[]>;
  getLogsThrows?: boolean;
}): PublicClient {
  return {
    getBlockNumber: async () => opts.latest,
    getLogs: async () => {
      if (opts.getLogsThrows) throw new Error("Please specify an address in your request");
      return (opts.mintedContracts ?? []).map((nftContract) => ({ args: { nftContract, minter: "0x1", feeRecipient: OPENSEA_FEE_RECIPIENT } }));
    },
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      const nftContract = (args[0] as string).toLowerCase();
      if (functionName === "getPublicDrop") return (opts.drops?.[nftContract] ?? UNSET_DROP) as unknown;
      if (functionName === "getAllowedFeeRecipients") return (opts.allowedFeeRecipients?.[nftContract] ?? []) as unknown;
      throw new Error(`unexpected functionName ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("SeaDropDiscoverySource", () => {
  test("surfaces a candidate for a currently free + open drop", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop() } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });

    const candidates = await source.discover();
    expect(candidates.length).toBe(1);
    expect(candidates[0].contract).toBe(SEADROP_ADDRESS);
    expect(candidates[0].mintFunction).toBe("mintPublic");
    expect(candidates[0].calldata).toBeDefined();
    expect(candidates[0].valueWei).toBe(0n);
    expect(candidates[0].metadata.nftContract).toBe(CONTRACT_A);
    expect(await cursor.get("seadrop:ethereum")).toBeDefined();
  });

  test("skips a drop that is no longer free", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop({ mintPrice: 1n }) } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("skips a drop outside its open time window", async () => {
    const cursor = memCursor();
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop({ startTime: now + 3600, endTime: now + 7200 }) } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("skips an unset SeaDrop mapping entry (all-zero tuple)", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A] });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("uses the first allowed fee recipient when the drop restricts them", async () => {
    const cursor = memCursor();
    const allowed = "0x0000000000000000000000000000000000000099" as `0x${string}`;
    const client = fakeClient({
      latest: 1000n,
      mintedContracts: [CONTRACT_A],
      drops: { [CONTRACT_A]: freeOpenDrop({ restrictFeeRecipients: true }) },
      allowedFeeRecipients: { [CONTRACT_A]: [allowed] },
    });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    const candidates = await source.discover();
    expect(candidates.length).toBe(1);
    expect(candidates[0].metadata.feeRecipient).toBe(allowed);
  });

  test("skips a restricted drop with no allowed fee recipients", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop({ restrictFeeRecipients: true }) } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("dedupes multiple mint events from the same contract into one candidate", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A, CONTRACT_A, CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop() } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect((await source.discover()).length).toBe(1);
  });

  test("handles multiple distinct contracts in one scan", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A, CONTRACT_B], drops: { [CONTRACT_A]: freeOpenDrop(), [CONTRACT_B]: freeOpenDrop() } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect((await source.discover()).length).toBe(2);
  });

  test("second scan resumes from cursor + 1, not the fixed recent window", async () => {
    const cursor = memCursor();
    await cursor.set("seadrop:base", 500n);
    let capturedFrom: bigint | undefined;
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => { capturedFrom = fromBlock; return []; },
      readContract: async () => UNSET_DROP,
    } as unknown as PublicClient;
    const source = new SeaDropDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    await source.discover();
    expect(capturedFrom).toBe(501n);
  });

  test("returns nothing once caught up (fromBlock past safeLatest)", async () => {
    const cursor = memCursor();
    await cursor.set("seadrop:base", 999n);
    const client = fakeClient({ latest: 1000n });
    const source = new SeaDropDiscoverySource({ chainKey: "base", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("returns empty and does not throw when getLogs fails", async () => {
    const cursor = memCursor();
    const client = fakeClient({ latest: 1000n, getLogsThrows: true });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("re-checks a previously known contract with no new mint event this pass, and keeps surfacing it while still free+open", async () => {
    const cursor = memCursor();
    const registry = memRegistry({ ethereum: [CONTRACT_A] });
    // No fresh mint events this scan, but CONTRACT_A is already in the registry from an earlier pass.
    const client = fakeClient({ latest: 1000n, mintedContracts: [], drops: { [CONTRACT_A]: freeOpenDrop() } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, registry, confirmations: 2n });

    const candidates = await source.discover();
    expect(candidates.length).toBe(1);
    expect(candidates[0].metadata.nftContract).toBe(CONTRACT_A);
  });

  test("stops surfacing a known contract once it's no longer free+open, without needing to be removed from the registry", async () => {
    const cursor = memCursor();
    const registry = memRegistry({ ethereum: [CONTRACT_A] });
    const client = fakeClient({ latest: 1000n, mintedContracts: [], drops: { [CONTRACT_A]: freeOpenDrop({ mintPrice: 1n }) } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, registry, confirmations: 2n });
    expect(await source.discover()).toEqual([]);
  });

  test("adds a newly-minted contract to the registry so future quiet scans still re-check it", async () => {
    const cursor = memCursor();
    const registry = memRegistry();
    const client = fakeClient({ latest: 1000n, mintedContracts: [CONTRACT_A], drops: { [CONTRACT_A]: freeOpenDrop() } });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, registry, confirmations: 2n });

    await source.discover();
    expect(await registry.list("ethereum")).toEqual([CONTRACT_A]);
  });

  test("merges newly-minted and previously-known contracts in one pass without duplicating", async () => {
    const cursor = memCursor();
    const registry = memRegistry({ ethereum: [CONTRACT_A] });
    const client = fakeClient({
      latest: 1000n,
      mintedContracts: [CONTRACT_A, CONTRACT_B],
      drops: { [CONTRACT_A]: freeOpenDrop(), [CONTRACT_B]: freeOpenDrop() },
    });
    const source = new SeaDropDiscoverySource({ chainKey: "ethereum", rpcUrls: [], client, cursor, registry, confirmations: 2n });

    const candidates = await source.discover();
    expect(candidates.length).toBe(2);
    expect(new Set(candidates.map((c) => c.metadata.nftContract))).toEqual(new Set([CONTRACT_A, CONTRACT_B]));
  });
});
