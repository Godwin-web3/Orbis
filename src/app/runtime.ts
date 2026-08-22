import { BlockContractDiscoverySource, EvmClaimInspector, EvmContractAbiInspector, EvmContractInspector, EvmEligibilityInspector, EvmRpcDiscoverySource, httpClaimProvider } from "../discovery";
import { DefaultCalldataBuilder } from "../discovery/contract/detector";
import { RuleClassifier } from "../core/classifier";
import { DefaultOpportunityEngine } from "../core/opportunity";
import { RpcSimulator } from "../simulation/rpc";
import { DefaultPolicyEngine } from "../execution/policy";
import { JsonlCandidateStore } from "../storage/jsonl";
import { JsonlPreparedTransactionStore } from "../execution/prepared";
import { RpcTransactionPreparer, makeClients } from "../execution/rpc-preparer";
import { ConsoleNotificationSink } from "../notifications/console";
import { JsonlNotificationSink } from "../notifications/jsonl";
import { MultiNotificationSink } from "../notifications/multi";
import { TelegramNotificationSink } from "../notifications/telegram";
import { MintEngine } from "./engine";
import { chains, enabledChains } from "../../config/chains";
import type { CandidateStore, NotificationSink, PreparedTransactionStore } from "../domain/ports";

class CompositeInspector { constructor(private readonly inspectors: { inspect(candidate: import("../domain/types").MintCandidate): Promise<import("../domain/types").MintCandidate> }[]) {} async inspect(candidate: import("../domain/types").MintCandidate) { let result = candidate; for (const inspector of this.inspectors) result = await inspector.inspect(result); return result; } }

function urlsFor(chainKey: string): string[] { const config = chains[chainKey]; return config ? (process.env[config.rpcEnv] ?? "").split(",").map((url) => url.trim()).filter(Boolean) : []; }

/**
 * `candidateStore`/`preparedStore`/`notifications` default to the local-filesystem
 * JSONL adapters. Pass Supabase-backed ones (see src/storage/supabase.ts) when running
 * somewhere without a filesystem, e.g. a Cloudflare Worker.
 */
export function buildRuntime(overrides?: { candidateStore?: CandidateStore; preparedStore?: PreparedTransactionStore; notifications?: NotificationSink[] }): MintEngine {
  const activeChains = enabledChains();
  const chainUrls = activeChains.flatMap((chain) => urlsFor(chain.key).map((rpcUrl) => ({ chainKey: chain.key, rpcUrl })));
  const sources = activeChains.flatMap((chain) => {
    const rpcUrls = urlsFor(chain.key); if (!rpcUrls.length) return [];
    const contracts = (process.env[`${chain.key.toUpperCase()}_CONTRACTS`] ?? "").split(",").map((address) => address.trim()).filter(Boolean) as `0x${string}`[];
    return [process.env.DISCOVERY_MODE === "blocks" ? new BlockContractDiscoverySource({ chainKey: chain.key, rpcUrls, confirmations: BigInt(process.env.CONFIRMATIONS ?? "2") }) : new EvmRpcDiscoverySource({ chainKey: chain.key, rpcUrls, contracts })];
  });
  const clients = makeClients(chainUrls);
  const notifications = overrides?.notifications ?? [new ConsoleNotificationSink(), new JsonlNotificationSink(process.env.EVENT_LOG ?? "data/events.jsonl")];
  if (!overrides?.notifications && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) notifications.push(new TelegramNotificationSink());
  const preparedStore = overrides?.preparedStore ?? new JsonlPreparedTransactionStore(process.env.PREPARED_LOG ?? "data/prepared-transactions.jsonl");
  const candidateStore = overrides?.candidateStore ?? new JsonlCandidateStore(process.env.CANDIDATE_LOG ?? "data/candidates.jsonl");
  const claimProvider = httpClaimProvider(process.env.CLAIM_DATA_API, process.env.CLAIM_DATA_API_TOKEN);
  return new MintEngine({ sources, classifier: new RuleClassifier(), opportunities: new DefaultOpportunityEngine(), simulator: new RpcSimulator(), policy: new DefaultPolicyEngine(), store: candidateStore, notifications: new MultiNotificationSink(notifications), inspector: new CompositeInspector([new EvmContractAbiInspector(chainUrls.map(({ rpcUrl }) => rpcUrl), undefined, undefined), new EvmContractInspector(chainUrls.map(({ rpcUrl }) => rpcUrl)), new EvmEligibilityInspector(chainUrls.map(({ rpcUrl }) => rpcUrl), process.env.SIMULATION_FROM as `0x${string}` | undefined), new EvmClaimInspector(claimProvider)]), calldata: new DefaultCalldataBuilder(), preparer: new RpcTransactionPreparer(clients, preparedStore) });
}
