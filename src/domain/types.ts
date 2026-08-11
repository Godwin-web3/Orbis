export type Address = `0x${string}`;
export type Scalar = string | number | boolean | readonly unknown[] | { readonly [key: string]: unknown };

export type MintCandidate = {
  id: string;
  chainKey: string;
  contract: Address;
  source: string;
  discoveredAt: string;
  mintFunction?: string;
  calldata?: `0x${string}`;
  valueWei: bigint;
  from?: Address;
  maxMintsPerWallet?: number;
  active?: boolean;
  eligible?: boolean;
  abi?: unknown[];
  eligibility?: EligibilitySnapshot;
  metadata: Record<string, Scalar>;
};

export type EligibilitySnapshot = { checkedAt: string; wallet?: Address; active?: boolean; eligible?: boolean; maxPerWallet?: string; mintedByWallet?: string; totalSupply?: string; maxSupply?: string; startTimestamp?: string; endTimestamp?: string; allowlistRequired?: boolean; allowlistProofAvailable?: boolean; reason?: string };
export type Classification = { isNft: boolean; isMintOrClaim: boolean; isFree: boolean; isActive: boolean; isEligible: boolean; paymentKind: "none" | "native" | "erc20" | "nft-burn" | "signature" | "unknown"; reasons: string[] };
export type AssetDiff = { kind: "nft" | "erc20" | "native" | "unknown"; direction: "in" | "out"; amount?: string; token?: Address; tokenId?: string; operator?: Address };
export type ApprovalDiff = { token: Address; owner?: Address; spender: Address; amount: string };
export type ExternalCall = { to?: Address; value?: string; input?: string };
export type StateDiff = { address: Address; field: string; before: string; after: string; kind: "balance" | "allowance" | "storage"; owner?: Address; spender?: Address };
export type SimulationResult = { success: boolean; gasEstimate?: bigint; gasPriceWei?: bigint; stateDiffAvailable: boolean; stateDiff?: StateDiff[]; assetDiff: AssetDiff[]; approvalDiff: ApprovalDiff[]; unexpectedCalls?: ExternalCall[]; externalValueTransfers?: { asset: "native" | "erc20" | "unknown"; amount: string; direction: "out" | "in" }[]; revertReason?: string; metadata?: Record<string, Scalar> };
export type Opportunity = { candidate: MintCandidate; classification: Classification; probability: number; estimatedValueNative: number; gasNative: number; executionRisk: number; expectedValueNative: number; priority: number };
export type TransactionRequest = { chainKey: string; to: Address; data: `0x${string}`; value: bigint; from?: Address; gas?: bigint };
export type PreparedTransaction = TransactionRequest & { chainId: number; gas: bigint; gasPriceWei: bigint; simulationMode: string; policy: "PASS" | "REJECT" | "SKIP"; reasons: string[]; preparedAt: string; candidateId?: string; mintFunction?: string; abi?: unknown[] };
