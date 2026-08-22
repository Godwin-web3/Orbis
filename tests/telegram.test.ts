import { describe, expect, test } from "bun:test";
import { parseCommand, formatPrepared, ADMIN_ONLY_COMMANDS, TelegramCommandBot } from "../src/telegram/bot";
import type { PreparedTransaction } from "../src/domain/types";
import type { PreparedTransactionStore } from "../src/domain/ports";
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
