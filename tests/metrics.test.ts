import { describe, expect, test } from "bun:test";
import { TimeToActionMetrics } from "../src/core/metrics";

describe("time-to-action metrics", () => {
  test("measures stage deltas", () => {
    const metrics = new TimeToActionMetrics();
    metrics.mark("candidate", "detected", 100);
    metrics.mark("candidate", "classified", 125);
    metrics.mark("candidate", "simulated", 180);
    metrics.mark("candidate", "decided", 200);
    expect(metrics.snapshot("candidate")).toMatchObject({ detectedToClassifiedMs: 25, classifiedToSimulatedMs: 55, simulatedToDecisionMs: 20, detectionToDecisionMs: 100, detectionToBroadcastMs: null });
  });
});
