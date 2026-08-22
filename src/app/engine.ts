import type { CalldataBuilder, CandidateStore, Classifier, ContractInspector, DiscoverySource, NotificationSink, OpportunityEngine, PolicyEngine, PreparedTransactionStore, Simulator } from "../domain/ports";
import { TimeToActionMetrics } from "../core/metrics";
import { buildCandidateReport } from "../core/report";
import type { MintCandidate, PreparedTransaction, TransactionRequest } from "../domain/types";
import type { RpcTransactionPreparer } from "../execution/rpc-preparer";

export class MintEngine {
  readonly metrics: TimeToActionMetrics;
  constructor(private readonly deps: { sources: DiscoverySource[]; classifier: Classifier; opportunities: OpportunityEngine; simulator: Simulator; policy: PolicyEngine; store: CandidateStore; notifications: NotificationSink; calldata?: CalldataBuilder; inspector?: ContractInspector; preparer?: RpcTransactionPreparer }, metrics = new TimeToActionMetrics()) { this.metrics = metrics; }
  async run() {
    const candidates = (await Promise.all(this.deps.sources.map((source) => source.discover()))).flat();
    const results = [];
    for (const original of candidates) results.push(await this.processOne(original));
    return { count: candidates.length, results };
  }

  /** Runs a single candidate through the full classify -> simulate -> policy -> prepare pipeline. Used by run() for each discovered candidate, and directly for a manually-supplied target (e.g. /target). */
  async processOne(original: MintCandidate) {
    this.metrics.mark(original.id, "detected");
    const inspected = this.deps.inspector ? await this.deps.inspector.inspect(original) : original;
    const candidate = this.deps.calldata && !inspected.calldata ? { ...inspected, calldata: (await this.deps.calldata.build(inspected)).data } : inspected;
    await this.deps.store.save(candidate);
    this.metrics.mark(candidate.id, "classified");
    const request = this.deps.calldata ? await this.deps.calldata.build(candidate) : this.requestFromCandidate(candidate);
    const simulation = await this.deps.simulator.simulate(candidate, request);
    this.metrics.mark(candidate.id, "simulated");
    const classification = await this.deps.classifier.classify(candidate, simulation);
    const opportunity = await this.deps.opportunities.score(candidate, classification, simulation);
    const decision = await this.deps.policy.evaluate(opportunity, simulation);
    this.metrics.mark(candidate.id, "decided");
    let prepared: PreparedTransaction | undefined;
    if (decision.allowed && this.deps.preparer) prepared = await this.deps.preparer.prepare(candidate, opportunity, simulation, decision, request);
    const result = buildCandidateReport(candidate, classification, simulation, opportunity, decision, this.metrics.snapshot(candidate.id), prepared);
    await this.deps.notifications.send(JSON.stringify(result));
    return result;
  }

  private requestFromCandidate(candidate: MintCandidate): TransactionRequest { if (!candidate.calldata) throw new Error(`candidate ${candidate.id} has no calldata`); return { chainKey: candidate.chainKey, to: candidate.contract, data: candidate.calldata, value: candidate.valueWei, from: candidate.from }; }
}
