import { describe, expect, test } from "bun:test";
import { parseCommand, formatPrepared, formatCountdown, formatDropStatus, dropLink, ADMIN_ONLY_COMMANDS, TelegramCommandBot } from "../src/telegram/bot";
import type { DropStatus, PreparedTransaction } from "../src/domain/types";
import type { DropStatusStore, PreparedTransactionStore } from "../src/domain/ports";
import type { UserRegistry } from "../src/users/registry";
import type { RpcExecutor } from "../src/execution/executor";

describe("parseCommand", () => {
  test("parses a bare command", () => {
    expect(parseCommand("/help")).toEqual({ command: "help", args: [] });
  });
  test("parses a command with args", () => {
    expect(parseCommand("/mint 3")).toEqual({ command: "mint", args: ["3"] });
  });
  test("parses @bot mention suffix", () => {
    expect(parseCommand("/status@MyBot")).toEqual({ command: "status", args: [] });
  });
  test("lowercases command", () => {
    expect(parseCommand("/SCAN")).toEqual({ command: "scan", args: [] });
  });
  test("strips surrounding whitespace and collapses args", () => {
    expect(parseCommand("  /ack   on  ")).toEqual({ command: "ack", args: ["on"] });
  });
  test("returns null for non-command text", () => {
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("formatPrepared", () => {
  const tx: PreparedTransaction = {
    chainKey: "base",
    chainId: 8453,
    to: "0x0000000000000000000000000000000000000001",
    data: "0x2db115440000000000000000000000000000000000000000000000000000000000000001",
    value: 0n,
    gas: 100000n,
    gasPriceWei: 1000000000n,
    simulationMode: "eth_call",
    policy: "PASS",
    reasons: [],
    preparedAt: "2026-08-11T00:00:00.000Z",
    mintFunction: "publicMint",
  };
  test("renders a readable row", () => {
    const out = formatPrepared(tx, 0);
    expect(out).toContain("[0] PASS");
    expect(out).toContain(tx.to);
    expect(out).toContain("publicMint");
  });
});

describe("ADMIN_ONLY_COMMANDS", () => {
  test("gates fleet-wide, spend-arming, and RPC-costing commands only", () => {
    expect([...ADMIN_ONLY_COMMANDS].sort()).toEqual(["ack", "mint-all", "mintall", "scan"]);
  });
  test("leaves the multi-user surface ungated", () => {
    for (const open of ["register", "mint", "sign", "submit", "status", "prepared", "help", "autokey", "auto", "autostatus", "forgetkey"]) {
      expect(ADMIN_ONLY_COMMANDS.has(open)).toBe(false);
    }
  });
});

describe("TelegramCommandBot authorization", () => {
  const tx: PreparedTransaction = {
    chainKey: "base",
    chainId: 8453,
    to: "0x0000000000000000000000000000000000000001",
    data: "0x2db115440000000000000000000000000000000000000000000000000000000000000001",
    value: 0n,
    gas: 100000n,
    gasPriceWei: 1000000000n,
    simulationMode: "eth_call",
    policy: "PASS",
    reasons: [],
    preparedAt: "2026-08-11T00:00:00.000Z",
    mintFunction: "publicMint",
  };

  function makeBot(withExecutor: boolean) {
    const prepared: PreparedTransactionStore = { save: async () => {}, list: async () => [tx] };
    const users: UserRegistry = {
      register: async (userId, address) => ({ userId, address, registeredAt: "now" }),
      addressFor: async () => "0x0000000000000000000000000000000000000002",
      list: async () => [],
    };
    const executed: string[] = [];
    const fakeExecutor = {
      address: "0x0000000000000000000000000000000000000003",
      execute: async () => { executed.push("execute"); return { txHash: "0xhash" as `0x${string}` }; },
      verify: async () => ({ success: true, ownerConfirmed: true }),
    } as unknown as RpcExecutor;
    const bot = new TelegramCommandBot("fake-token", ["admin-1"], {
      prepared,
      users,
      executor: withExecutor ? fakeExecutor : undefined,
      guard: { get: () => true, set: async () => {} },
      scan: async () => 0,
      chainsEnabled: [],
    });
    return { bot, executed };
  }

  test("with no relay configured, /mint from a non-admin is refused (would spend the operator's own key)", async () => {
    const { bot, executed } = makeBot(true);
    const reply = await bot.handleCommand("stranger", { command: "mint", args: ["0"] });
    expect(reply).toContain("Restricted to the operator");
    expect(executed).toEqual([]);
  });

  test("with no relay configured, /mint from the admin chat is allowed", async () => {
    const { bot, executed } = makeBot(true);
    const reply = await bot.handleCommand("admin-1", { command: "mint", args: ["0"] });
    expect(reply).toContain("MINTING");
    expect(executed).toEqual(["execute"]);
  });

  test("/status and /register work for any chat regardless of admin list", async () => {
    const { bot } = makeBot(false);
    await expect(bot.handleCommand("stranger", { command: "status", args: [] })).resolves.toContain("status");
    const reply = await bot.handleCommand("stranger", { command: "register", args: ["0x0000000000000000000000000000000000000009"] });
    expect(reply).toContain("Registered");
  });

  test("/autokey and friends report the feature disabled when no keystore is configured", async () => {
    const { bot } = makeBot(false);
    expect(await bot.handleCommand("stranger", { command: "autokey", args: ["0xkey"] })).toContain("isn't enabled");
    expect(await bot.handleCommand("stranger", { command: "auto", args: ["on"] })).toContain("isn't enabled");
  });
});

describe("formatCountdown", () => {
  test("shows days + hours for anything a day or more out", () => {
    expect(formatCountdown(2 * 86400 + 3 * 3600)).toBe("2d 3h");
  });
  test("shows hours + minutes under a day", () => {
    expect(formatCountdown(2 * 3600 + 15 * 60)).toBe("2h 15m");
  });
  test("shows minutes only under an hour", () => {
    expect(formatCountdown(45 * 60)).toBe("45m");
  });
  test("floors under a minute to a friendly message, never negative", () => {
    expect(formatCountdown(30)).toBe("under a minute");
    expect(formatCountdown(-100)).toBe("under a minute");
  });
});

describe("formatDropStatus", () => {
  const base: DropStatus = { id: "ethereum:0x1", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000001", source: "seadrop", status: "live_free", mintPriceWei: "0", startTime: 0, endTime: 0, maxTotalMintableByWallet: 5, checkedAt: "now" };
  test("upcoming shows a countdown to opening", () => {
    const now = 1000;
    const out = formatDropStatus({ ...base, status: "upcoming", startTime: now + 3600 }, now);
    expect(out).toContain("opens in 1h 0m");
  });
  test("live_free shows the per-wallet cap and closing countdown", () => {
    const now = 1000;
    const out = formatDropStatus({ ...base, status: "live_free", maxTotalMintableByWallet: 3, endTime: now + 1800 }, now);
    expect(out).toContain("max 3/wallet");
    expect(out).toContain("closes in 30m");
  });
  test("live_free with no end time omits the closing countdown", () => {
    const out = formatDropStatus({ ...base, status: "live_free", endTime: 0 }, 1000);
    expect(out).not.toContain("closes in");
  });
  test("live_paid shows the price in ETH", () => {
    const out = formatDropStatus({ ...base, status: "live_paid", mintPriceWei: "1000000000000000" }, 1000);
    expect(out).toContain("0.001 ETH");
  });
  test("includes the collection name in the title when known", () => {
    const out = formatDropStatus({ ...base, name: "Cool Cats" }, 1000);
    expect(out).toContain("Cool Cats (0x0000000000000000000000000000000000000001)");
  });
  test("falls back to the bare contract address when no name is known", () => {
    const out = formatDropStatus(base, 1000);
    expect(out).not.toContain("undefined");
    expect(out).toContain("0x0000000000000000000000000000000000000001");
  });
  test("appends the drop's OpenSea/explorer link", () => {
    const out = formatDropStatus(base, 1000);
    expect(out).toContain("https://opensea.io/assets/ethereum/0x0000000000000000000000000000000000000001");
  });
});

describe("dropLink", () => {
  test("builds an OpenSea link when the chain has an OpenSea slug", () => {
    expect(dropLink("base", "0xabc")).toBe("https://opensea.io/assets/base/0xabc");
  });
  test("falls back to the block explorer when OpenSea doesn't cover the chain", () => {
    expect(dropLink("sepolia", "0xabc")).toBe("https://sepolia.etherscan.io/address/0xabc");
  });
  test("returns undefined for an unknown chain", () => {
    expect(dropLink("nope", "0xabc")).toBeUndefined();
  });
});

describe("/upcoming command", () => {
  function makeBotWithDropStatus(statuses: DropStatus[] | undefined) {
    const prepared: PreparedTransactionStore = { save: async () => {}, list: async () => [] };
    const users: UserRegistry = { register: async (userId, address) => ({ userId, address, registeredAt: "now" }), addressFor: async () => undefined, list: async () => [] };
    const dropStatus: DropStatusStore | undefined = statuses ? { save: async () => {}, list: async () => statuses } : undefined;
    return new TelegramCommandBot("fake-token", ["admin-1"], { prepared, users, guard: { get: () => false, set: async () => {} }, scan: async () => 0, chainsEnabled: [], dropStatus });
  }

  test("reports when drop status tracking isn't wired up", async () => {
    const bot = makeBotWithDropStatus(undefined);
    expect(await bot.handleCommand("x", { command: "upcoming", args: [] })).toContain("isn't wired up");
  });

  test("reports when nothing has been checked yet", async () => {
    const bot = makeBotWithDropStatus([]);
    expect(await bot.handleCommand("x", { command: "upcoming", args: [] })).toContain("No known drops yet");
  });

  test("groups by status and sorts upcoming by soonest first", async () => {
    const now = Math.floor(Date.now() / 1000);
    const statuses: DropStatus[] = [
      { id: "e:1", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000001", source: "seadrop", status: "upcoming", mintPriceWei: "0", startTime: now + 7200, endTime: 0, maxTotalMintableByWallet: 1, checkedAt: "now" },
      { id: "e:2", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000002", source: "seadrop", status: "upcoming", mintPriceWei: "0", startTime: now + 1800, endTime: 0, maxTotalMintableByWallet: 1, checkedAt: "now" },
      { id: "e:3", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000003", source: "seadrop", status: "live_free", mintPriceWei: "0", startTime: 0, endTime: 0, maxTotalMintableByWallet: 5, checkedAt: "now" },
      { id: "e:4", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000004", source: "seadrop", status: "ended", mintPriceWei: "0", startTime: 0, endTime: now - 100, maxTotalMintableByWallet: 5, checkedAt: "now" },
    ];
    const bot = makeBotWithDropStatus(statuses);
    const reply = await bot.handleCommand("x", { command: "upcoming", args: [] });
    expect(reply.indexOf("0x0000000000000000000000000000000000000002")).toBeLessThan(reply.indexOf("0x0000000000000000000000000000000000000001"));
    expect(reply).toContain("LIVE & FREE (1)");
    expect(reply).toContain("1 ended drop(s) not shown");
    expect(reply).not.toContain("0x0000000000000000000000000000000000000004");
  });

  test("says nothing's live or upcoming when everything known has ended", async () => {
    const now = Math.floor(Date.now() / 1000);
    const statuses: DropStatus[] = [{ id: "e:1", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000001", source: "seadrop", status: "ended", mintPriceWei: "0", startTime: 0, endTime: now - 100, maxTotalMintableByWallet: 1, checkedAt: "now" }];
    const bot = makeBotWithDropStatus(statuses);
    expect(await bot.handleCommand("x", { command: "upcoming", args: [] })).toContain("Nothing upcoming or live right now");
  });
});
