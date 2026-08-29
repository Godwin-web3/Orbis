import { describe, expect, test } from "bun:test";
import { formatAlert, TelegramAlertSink } from "../src/notifications/telegram";
import type { CandidateReport } from "../src/core/report";
import type { MintCandidate } from "../src/domain/types";

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function candidate(overrides: Partial<MintCandidate["metadata"]> = {}): MintCandidate {
  return {
    id: "ethereum:seadrop:0xaa",
    chainKey: "ethereum",
    contract: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5",
    source: "seadrop",
    discoveredAt: new Date().toISOString(),
    mintFunction: "mintPublic",
    calldata: "0x1234",
    valueWei: 0n,
    active: true,
    eligible: true,
    metadata: { assetType: "nft", nftContract: "0x00000000000000000000000000000000000000aa", name: "Hot Drop", ...overrides },
  };
}

function report(decision: CandidateReport["decision"], reasons: string[], overrides: Partial<MintCandidate["metadata"]> = {}): CandidateReport {
  return {
    candidate: candidate(overrides),
    decision,
    reasons,
    classification: { isNft: true, isMintOrClaim: true, isFree: true, isActive: true, isEligible: true, paymentKind: "none", reasons: [] },
    simulation: { success: true, stateDiffAvailable: false, assetDiff: [], approvalDiff: [] },
    opportunity: { probability: 0.55, estimatedValueNative: 0, gasNative: 0, executionRisk: 0.1, expectedValueNative: 0, priority: 0 },
    timing: {},
  };
}

describe("formatAlert", () => {
  test("drops a SKIP with no value signal", () => {
    expect(formatAlert(report("SKIP", ["no demand or floor — likely worthless"]))).toBeUndefined();
  });

  test("drops a REJECT with no value signal", () => {
    expect(formatAlert(report("REJECT", ["simulation produced token approval"]))).toBeUndefined();
  });

  test("surfaces a PASS", () => {
    const text = formatAlert(report("PASS", []));
    expect(text).toContain("PASS");
    expect(text).toContain("Hot Drop");
  });

  test("surfaces a SKIP that still has independent demand evidence", () => {
    const text = formatAlert(report("SKIP", ["gas exceeds 0.005 native token limit"], { valueSignal: true, recentMints: 12 }));
    expect(text).toContain("hot but skipped");
    expect(text).toContain("12 mints this window");
    expect(text).toContain("gas exceeds");
  });
});

describe("TelegramAlertSink", () => {
  test("never calls the network when a report doesn't clear the bar", async () => {
    let called = false;
    const sink = new TelegramAlertSink("token", "chat");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    try {
      await sink.send(stringify(report("SKIP", ["no demand or floor — likely worthless"])));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  test("posts to Telegram for a PASS", async () => {
    let body: unknown;
    const sink = new TelegramAlertSink("token", "chat");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      body = JSON.parse(init.body ?? "{}");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await sink.send(stringify(report("PASS", [])));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect((body as { chat_id: string }).chat_id).toBe("chat");
    expect((body as { text: string }).text).toContain("PASS");
  });
});
