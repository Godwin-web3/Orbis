import { describe, expect, test } from "bun:test";
import { selectArmTargets, resolveSnipeGas, SEADROP_PUBLIC_MINT_GAS } from "../src/execution/snipe";
import type { DropStatus } from "../src/domain/types";

function status(overrides: Partial<DropStatus> = {}): DropStatus {
  return { id: "ethereum:0x1", chainKey: "ethereum", nftContract: "0x0000000000000000000000000000000000000001", source: "seadrop", status: "upcoming", mintPriceWei: "0", startTime: 0, endTime: 0, maxTotalMintableByWallet: 1, checkedAt: "now", ...overrides };
}

describe("selectArmTargets", () => {
  test("arms a drop whose start time falls inside the lead window", () => {
    const now = 1000;
    const target = status({ startTime: now + 10 });
    expect(selectArmTargets([target], now, 15, new Set())).toEqual([target]);
  });

  test("ignores a drop whose start time is further out than the lead window", () => {
    const now = 1000;
    const target = status({ startTime: now + 100 });
    expect(selectArmTargets([target], now, 15, new Set())).toEqual([]);
  });

  test("ignores a drop that has already started", () => {
    const now = 1000;
    const target = status({ startTime: now - 5 });
    expect(selectArmTargets([target], now, 15, new Set())).toEqual([]);
  });

  test("ignores anything not status 'upcoming'", () => {
    const now = 1000;
    const target = status({ startTime: now + 10, status: "live_free" });
    expect(selectArmTargets([target], now, 15, new Set())).toEqual([]);
  });

  test("skips a target already being armed (avoids double-arming on consecutive ticks)", () => {
    const now = 1000;
    const target = status({ id: "already-arming", startTime: now + 10 });
    expect(selectArmTargets([target], now, 15, new Set(["already-arming"]))).toEqual([]);
  });

  test("arms multiple qualifying targets across chains at once", () => {
    const now = 1000;
    const a = status({ id: "a", chainKey: "ethereum", startTime: now + 5 });
    const b = status({ id: "b", chainKey: "robinhood", startTime: now + 12 });
    const result = selectArmTargets([a, b], now, 15, new Set());
    expect(result).toHaveLength(2);
  });
});

describe("resolveSnipeGas", () => {
  test("uses a live estimate with 20% headroom when the window is already open", async () => {
    expect(await resolveSnipeGas(async () => 200_000n)).toBe(240_000n);
  });

  test("falls back to the SeaDrop ceiling when estimateGas reverts (sale not open yet)", async () => {
    expect(await resolveSnipeGas(async () => { throw new Error("execution reverted"); })).toBe(SEADROP_PUBLIC_MINT_GAS);
  });

  test("falls back when estimateGas returns 0", async () => {
    expect(await resolveSnipeGas(async () => 0n)).toBe(SEADROP_PUBLIC_MINT_GAS);
  });
});
