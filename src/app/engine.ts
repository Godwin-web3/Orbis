import type { CalldataBuilder, CandidateStore, Classifier, ContractInspector, DiscoverySource, NotificationSink, OpportunityEngine, PolicyEngine, PreparedTransactionStore, Simulator, ValueOracle } from "../domain/ports";
import { TimeToActionMetrics } from "../core/metrics";
import { buildCandidateReport } from "../core/report";
import type { MintCandidate, PreparedTransaction, TransactionRequest } from "../domain/types";
import type { RpcTransactionPreparer } from "../execution/rpc-preparer";

export class MintEngine {
  readonly metrics: TimeToActionMetrics;
  constructor(private readonly deps: { sources: DiscoverySource[]; classifier: Classifier; opportunities: OpportunityEngine; simulator: Simulator; policy: PolicyEngine; store: CandidateStore; notifications: NotificationSink; calldata?: CalldataBuilder; inspector?: ContractInspector; preparer?: RpcTransactionPreparer; valueOracle?: ValueOracle }, metrics = new TimeToActionMetrics()) { this.metrics = metrics; }
  async run() {
    const candidates = (await Promise.all(this.deps.sources.map((source) => source.discover()))).flat();
    const results = [];
    for (const original of candidates) results.push(await this.processOne(original));
    return { count: candidates.length, results };
  }

  /** Runs a single candidate through the full classify -> simulate -> policy -> prepare pipeline. Used by run() for each discovered candidate, and directly for a manually-supplied target (e.g. /target). */
  async processOne(original: MintCandidate) {
    this.metrics.mark(original.id, "detected");
    // The generic inspectors (ABI resolution, eligibility reads, etc.) exist to figure out
    // what a candidate CAN'T tell us on its own. A candidate that already arrives with
    // calldata set (e.g. SeaDrop's — see seadrop-source.ts) is self-sufficient: it already
    // verified price/eligibility/window directly against its own known-good contract before
    // being surfaced, so running it through inspectors built for arbitrary/unknown
    // contracts is redundant at best — and actively wrong for SeaDrop, whose `contract` is
    // the shared SeaDrop singleton, not the actual NFT contract, so eligibility reads like
    // maxPerWallet/mintedPerWallet would check the wrong address entirely. Skipping this
    // also matters for Cloudflare's per-invocation subrequest budget: each inspector call
    // is its own RPC round trip, multiplied across every candidate in a scan pass.
    const inspected = this.deps.inspector && !original.calldata ? await this.deps.inspector.inspect(original) : original;
    const valued = this.deps.valueOracle ? await this.deps.valueOracle.enrich(inspected) : inspected;
    const request = valued.calldata
      ? this.requestFromCandidate(valued)
      : this.deps.calldata
        ? await this.deps.calldata.build(valued)
        : undefined;
    if (!request) throw new Error(`candidate ${valued.id} has no calldata`);
    const candidate = valued.calldata ? valued : { ...valued, calldata: request.data };
    await this.deps.store.save(candidate);
    this.metrics.mark(candidate.id, "classified");
    const simulation = await this.deps.simulator.simulate(candidate, request);
    this.metrics.mark(candidate.id, "simulated");
    const classification = await this.deps.classifier.classify(candidate, simulation);
    const opportunity = await this.deps.opportunities.score(candidate, classification, simulation);
    const decision = await this.deps.policy.evaluate(opportunity, simulation);
    this.metrics.mark(candidate.id, "decided");
    let prepared: PreparedTransaction | undefined;
    if (decision.allowed && this.deps.preparer) prepared = await this.deps.preparer.prepare(candidate, opportunity, simulation, decision, request);
    const result = buildCandidateReport(candidate, classification, simulation, opportunity, decision, this.metrics.snapshot(candidate.id), prepared);
    await this.deps.notifications.send(stringifyReport(result));
    return result;
  }

  private requestFromCandidate(candidate: MintCandidate): TransactionRequest { if (!candidate.calldata) throw new Error(`candidate ${candidate.id} has no calldata`); return { chainKey: candidate.chainKey, to: candidate.contract, data: candidate.calldata, value: candidate.valueWei, from: candidate.from }; }
}

// The report embeds the raw candidate (valueWei: bigint) and, on a PASS, the prepared
// transaction (value/gas/gasPriceWei: bigint) — plain JSON.stringify throws on those
// ("Do not know how to serialize a BigInt"), so every bigint is stringified via a replacer
// instead of chasing down each individual field.
function stringifyReport(result: unknown): string {
  return JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}
