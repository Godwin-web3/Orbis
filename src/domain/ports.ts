import type { Classification, DropStatus, MintCandidate, Opportunity, PreparedTransaction, SimulationResult, TransactionRequest } from "./types";
export interface DiscoverySource { readonly name: string; discover(): Promise<MintCandidate[]>; }
export interface ContractInspector { inspect(candidate: MintCandidate): Promise<MintCandidate>; }
export interface CalldataBuilder { build(candidate: MintCandidate): Promise<TransactionRequest>; }
export interface Classifier { classify(candidate: MintCandidate, simulation?: SimulationResult): Promise<Classification>; }
export interface Simulator { simulate(candidate: MintCandidate, request?: TransactionRequest): Promise<SimulationResult>; }
export interface OpportunityEngine { score(candidate: MintCandidate, classification: Classification, simulation: SimulationResult): Promise<Opportunity>; }
export interface ValueOracle { enrich(candidate: MintCandidate): Promise<MintCandidate>; }
export interface PolicyEngine { evaluate(opportunity: Opportunity, simulation: SimulationResult): Promise<{ allowed: boolean; reasons: string[] }>; }
export interface PreparedTransactionStore { save(transaction: PreparedTransaction): Promise<void>; list(): Promise<PreparedTransaction[]>; }
export interface Signer { sign(request: TransactionRequest): Promise<`0x${string}`>; }
export interface NonceManager { reserve(chainKey: string): Promise<number>; release(chainKey: string, nonce: number): Promise<void>; }
export interface Broadcaster { send(rawTransaction: `0x${string}`): Promise<`0x${string}`>; }
export interface Executor { execute(request: TransactionRequest): Promise<{ txHash: `0x${string}` }>; }
export interface GasStrategy { gasLimit(simulation: SimulationResult): bigint | undefined; }
export interface NotificationSink { send(message: string): Promise<void>; }
export interface CandidateStore { save(candidate: MintCandidate): Promise<void>; list(): Promise<MintCandidate[]>; }
export interface DropStatusStore { save(status: DropStatus): Promise<void>; list(): Promise<DropStatus[]>; }
