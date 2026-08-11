export type PipelineStage = "detected" | "classified" | "simulated" | "decided" | "broadcast" | "included" | "verified";
export type PipelineTiming = { candidateId: string; timestamps: Partial<Record<PipelineStage, number>> };

export class TimeToActionMetrics {
  private readonly timings = new Map<string, PipelineTiming>();
  mark(candidateId: string, stage: PipelineStage, timestamp = performance.now()): void { const entry = this.timings.get(candidateId) ?? { candidateId, timestamps: {} }; entry.timestamps[stage] = timestamp; this.timings.set(candidateId, entry); }
  snapshot(candidateId: string): Record<string, string | number | null> { const t = this.timings.get(candidateId)?.timestamps ?? {}; return { candidateId, detectedToClassifiedMs: this.delta(t.detected, t.classified), classifiedToSimulatedMs: this.delta(t.classified, t.simulated), simulatedToDecisionMs: this.delta(t.simulated, t.decided), decisionToBroadcastMs: this.delta(t.decided, t.broadcast), broadcastToInclusionMs: this.delta(t.broadcast, t.included), inclusionToVerificationMs: this.delta(t.included, t.verified), detectionToDecisionMs: this.delta(t.detected, t.decided), detectionToBroadcastMs: this.delta(t.detected, t.broadcast) }; }
  all(): Record<string, string | number | null>[] { return [...this.timings.keys()].map((candidateId) => this.snapshot(candidateId)); }
  private delta(start: number | undefined, end: number | undefined): number | null { return start === undefined || end === undefined ? null : Math.max(0, end - start); }
}
