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
import type { CandidateStore, DropStatusStore, NotificationSink, PreparedTransactionStore } from "../domain/ports";
import { JsonlBlockCursorStore, type BlockCursorStore } from "../discovery/rpc/block-cursor";
import { JsonlContractRegistry, type ContractRegistry } from "../discovery/rpc/contract-registry";
import { JsonlDropStatusStore } from "../discovery/rpc/drop-status";
import { SeaDropDiscoverySource } from "../discovery/rpc/seadrop-source";
import { CollectionValueOracle } from "../discovery/value/oracle";
import { fetchTrendingFreeMints } from "../discovery/heat/trending";
import { RobinhoodLaunchpadSource } from "../discovery/launchpads/source";

class CompositeInspector { constructor(private readonly inspectors: { inspect(candidate: import("../domain/types").MintCandidate): Promise<import("../domain/types").MintCandidate> }[]) {} async inspect(candidate: import("../domain/types").MintCandidate) { let result = candidate; for (const inspector of this.inspectors) result = await inspector.inspect(result); return result; } }

export function urlsFor(chainKey: string): string[] { const config = chains[chainKey]; return config ? (process.env[config.rpcEnv] ?? "").split(",").map((url) => url.trim()).filter(Boolean) : []; }

export function buildRuntime(overrides?: { candidateStore?: CandidateStore; preparedStore?: PreparedTransactionStore; notifications?: NotificationSink[]; blockCursor?: BlockCursorStore; contractRegistry?: ContractRegistry; dropStatusStore?: DropStatusStore; chainKeys?: string[] }): MintEngine {
  const activeChains = enabledChains().filter((chain) => !overrides?.chainKeys || overrides.chainKeys.includes(chain.key));
  const chainUrls = activeChains.flatMap((chain) => urlsFor(chain.key).map((rpcUrl) => ({ chainKey: chain.key, rpcUrl })));
  const blockCursor = overrides?.blockCursor ?? new JsonlBlockCursorStore(process.env.BLOCK_CURSOR_PATH ?? "data/block-cursor.json");
  const contractRegistry = overrides?.contractRegistry ?? new JsonlContractRegistry(process.env.CONTRACT_REGISTRY_PATH ?? "data/contract-registry.json");
  const dropStatusStore = overrides?.dropStatusStore ?? new JsonlDropStatusStore(process.env.DROP_STATUS_PATH ?? "data/drop-status.json");
  const etherscanApiKey = process.env.ETHERSCAN_API_KEY;
  const etherscanChains = new Set((process.env.ETHERSCAN_CHAINS ?? "ethereum").split(",").map((key) => key.trim()).filter(Boolean));
  const etherscanFor = (chainKey: string) => etherscanApiKey && etherscanChains.has(chainKey) ? { apiKey: etherscanApiKey, chainId: chains[chainKey].chainId } : undefined;

  const sources = activeChains.flatMap((chain) => {
    const rpcUrls = urlsFor(chain.key); if (!rpcUrls.length) return [];
    const contracts = (process.env[`${chain.key.toUpperCase()}_CONTRACTS`] ?? "").split(",").map((address) => address.trim()).filter(Boolean) as `0x${string}`[];
    const etherscan = etherscanFor(chain.key);
    const primary = process.env.DISCOVERY_MODE === "blocks" ? new BlockContractDiscoverySource({ chainKey: chain.key, rpcUrls, confirmations: BigInt(process.env.CONFIRMATIONS ?? "2"), cursor: blockCursor, etherscan, dropStatusStore }) : new EvmRpcDiscoverySource({ chainKey: chain.key, rpcUrls, contracts });
    const seadrop = process.env.SEADROP_DISCOVERY === "off" ? [] : [new SeaDropDiscoverySource({
      chainKey: chain.key,
      rpcUrls,
      confirmations: BigInt(process.env.CONFIRMATIONS ?? "2"),
      cursor: blockCursor,
      registry: contractRegistry,
      etherscan,
      dropStatusStore,
      boosts: chain.key === "ethereum" && (process.env.TRENDING_DISCOVERY ?? "on") !== "off"
        ? async () => (await fetchTrendingFreeMints("ethereum")).map((row) => ({
          contract: row.contract,
          recentMints: row.mintCount,
          uniqueMinters: row.uniqueMinters,
          name: row.name,
          floorNative: row.floorNative,
        }))
        : undefined,
    })];
    const launchpads = chain.key === "robinhood" && (process.env.RH_LAUNCHPADS ?? "on") !== "off"
      ? [new RobinhoodLaunchpadSource({ chainKey: chain.key, rpcUrls, dropStatusStore })]
      : [];
    return [primary, ...seadrop, ...launchpads];
  });
  const clients = makeClients(chainUrls);
  const notifications = overrides?.notifications ?? [new ConsoleNotificationSink(), new JsonlNotificationSink(process.env.EVENT_LOG ?? "data/events.jsonl")];
  if (!overrides?.notifications && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) notifications.push(new TelegramNotificationSink());
  const preparedStore = overrides?.preparedStore ?? new JsonlPreparedTransactionStore(process.env.PREPARED_LOG ?? "data/prepared-transactions.jsonl");
  const candidateStore = overrides?.candidateStore ?? new JsonlCandidateStore(process.env.CANDIDATE_LOG ?? "data/candidates.jsonl");
  const claimProvider = httpClaimProvider(process.env.CLAIM_DATA_API, process.env.CLAIM_DATA_API_TOKEN);
  return new MintEngine({ sources, classifier: new RuleClassifier(), opportunities: new DefaultOpportunityEngine(), simulator: new RpcSimulator(), policy: new DefaultPolicyEngine(), store: candidateStore, notifications: new MultiNotificationSink(notifications), inspector: new CompositeInspector([new EvmContractAbiInspector(chainUrls.map(({ rpcUrl }) => rpcUrl), undefined, undefined), new EvmContractInspector(chainUrls.map(({ rpcUrl }) => rpcUrl)), new EvmEligibilityInspector(chainUrls.map(({ rpcUrl }) => rpcUrl), process.env.SIMULATION_FROM as `0x${string}` | undefined), new EvmClaimInspector(claimProvider)]), calldata: new DefaultCalldataBuilder(), preparer: new RpcTransactionPreparer(clients, preparedStore), valueOracle: new CollectionValueOracle() });
}
