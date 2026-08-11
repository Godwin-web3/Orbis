import { describe, expect, test } from "bun:test";
import { parseCommand, formatPrepared } from "../src/telegram/bot";
import type { PreparedTransaction } from "../src/domain/types";

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
