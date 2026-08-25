import { createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia, base, arbitrum, optimism, polygon } from "viem/chains";
import type { Executor } from "../domain/ports";
import type { PreparedTransaction } from "../domain/types";

export const MINTER_ABI = [
  { inputs: [{ name: "_quantity", type: "uint256" }], name: "publicMint", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [], name: "mintPriceInWei", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "isPublicMintOpen", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MAX_LIMIT_PER_PUBLIC_ADDRS", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export const ERC721_BALANCE_ABI = [
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export const BATCH_EXECUTOR_ABI = [
  {
    name: "execute",
    type: "function",
    inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

export type BatchCall = { to: Address; value: bigint; data: `0x${string}` };
export type BatchResult = { chainId: number; txHash: Address; count: number };

export const chainById = new Map<number, Chain>([
  [1, mainnet],
  [11155111, sepolia],
  [8453, base],
  [42161, arbitrum],
  [10, optimism],
  [137, polygon],
  [4663, defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } })],
]);

export const RPC_ENV_BY_CHAIN_ID: Record<number, string> = {
  1: "ETHEREUM_RPC_URL",
  11155111: "SEPOLIA_RPC_URL",
  8453: "BASE_RPC_URL",
  42161: "ARBITRUM_RPC_URL",
  10: "OPTIMISM_RPC_URL",
  137: "POLYGON_RPC_URL",
  4663: "ROBINHOOD_RPC_URL",
};

function chainFor(chainId: number): Chain {
  const chain = chainById.get(chainId);
  if (!chain) throw new Error(`No chain mapping for chainId ${chainId}`);
  return chain;
}

function hasMethod(abi: unknown[] | undefined, name: string): boolean {
  return Array.isArray(abi) && abi.some((item) => item && typeof item === "object" && (item as { name?: string }).name === name);
}

export class RpcExecutor implements Executor {
  readonly address: Address;
  private readonly wallet: WalletClient;
  private readonly account;
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(private readonly privKey: string, private readonly rpcOverride?: string) {
    const account = privateKeyToAccount(privKey as `0x${string}`);
    this.account = account;
    this.address = account.address;
    this.wallet = createWalletClient({ account, transport: http() });
  }

  private publicClient(chainId: number): PublicClient {
    let client = this.publicClients.get(chainId);
    if (!client) {
      const chain = chainFor(chainId);
      const rpc = this.rpcOverride ?? process.env[RPC_ENV_BY_CHAIN_ID[chainId]];
      if (!rpc) throw new Error(`No RPC URL configured for chainId ${chainId} (set ${RPC_ENV_BY_CHAIN_ID[chainId]})`);
      client = createPublicClient({ chain, transport: http(rpc) });
      this.publicClients.set(chainId, client);
    }
    return client;
  }

  private async guardAgainstStaleMint(chainId: number, prepared: PreparedTransaction): Promise<bigint> {
    const publicClient = this.publicClient(chainId);
    const abi = (prepared.abi as unknown[] | undefined) ?? (MINTER_ABI as unknown as unknown[]);
    const from = (prepared.from ?? this.address) as Address;
    const args = { address: prepared.to, abi, account: from } as const;

    const price = hasMethod(abi, "mintPriceInWei") ? (await publicClient.readContract({ ...args, functionName: "mintPriceInWei" })) as bigint : 0n;
    const open = hasMethod(abi, "isPublicMintOpen") ? (await publicClient.readContract({ ...args, functionName: "isPublicMintOpen" })) as boolean : true;
    const owned = hasMethod(abi, "balanceOf") ? (await publicClient.readContract({ ...args, functionName: "balanceOf" })) as bigint : 0n;
    const limit = hasMethod(abi, "MAX_LIMIT_PER_PUBLIC_ADDRS") ? (await publicClient.readContract({ ...args, functionName: "MAX_LIMIT_PER_PUBLIC_ADDRS" })) as bigint : 0n;

    if (price !== 0n) throw new Error(`Mint is no longer free (price=${price.toString()} wei). Aborting.`);
    if (open === false) throw new Error("Mint is closed. Aborting.");
    // limit === 0n means the ABI has no per-address cap (SeaDrop and most generic mints).
    // Treating 0 as a real cap aborted every SeaDrop /mint with "0/0".
    if (limit !== 0n && owned + 1n > limit) throw new Error(`Per-address limit reached (${owned.toString()}/${limit.toString()}). Aborting.`);
    return owned;
  }

  async execute(prepared: PreparedTransaction): Promise<{ txHash: Address }> {
    const chain = chainFor(prepared.chainId);
    const publicClient = this.publicClient(prepared.chainId);
    const from = (prepared.from ?? this.address) as Address;

    await this.guardAgainstStaleMint(prepared.chainId, prepared);

    const balance = await publicClient.getBalance({ address: from });
    const gas = prepared.gas > 0n ? prepared.gas : 120_000n;
    const gasPrice = prepared.gasPriceWei > 0n ? prepared.gasPriceWei : await publicClient.getGasPrice();
    if (balance < gas * gasPrice) throw new Error("Insufficient wallet balance for gas. Aborting.");

    const hash = await this.wallet.sendTransaction({ account: this.account, to: prepared.to, data: prepared.data, value: prepared.value, chain });
    return { txHash: hash };
  }

  async executeBatch(preparedList: PreparedTransaction[]): Promise<BatchResult[]> {
    const batchExecutor = process.env.BATCH_EXECUTOR_ADDRESS as Address | undefined;
    if (!batchExecutor) throw new Error("BATCH_EXECUTOR_ADDRESS is not set. Deploy a 7702 batch delegate and set it.");
    if (!preparedList.length) throw new Error("No prepared mints to batch.");

    const byChain = new Map<number, PreparedTransaction[]>();
    for (const prepared of preparedList) {
      const group = byChain.get(prepared.chainId) ?? [];
      group.push(prepared);
      byChain.set(prepared.chainId, group);
    }

    const results: BatchResult[] = [];
    for (const [chainId, group] of byChain) {
      const chain = chainFor(chainId);
      const publicClient = this.publicClient(chainId);
      const from = (group[0].from ?? this.address) as Address;

      const calls: BatchCall[] = [];
      for (const prepared of group) {
        await this.guardAgainstStaleMint(chainId, prepared);
        calls.push({ to: prepared.to, value: prepared.value, data: prepared.data as `0x${string}` });
      }
      const data = encodeFunctionData({ abi: BATCH_EXECUTOR_ABI, functionName: "execute", args: [calls] });

      const nonce = await publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      const auth = await this.account.signAuthorization({
        contractAddress: batchExecutor,
        chainId,
        nonce,
      });

      const gas = await publicClient.estimateGas({ account: from, to: from, data, value: 0n, authorizationList: [auth] });
      const gasPrice = await publicClient.getGasPrice();
      const balance = await publicClient.getBalance({ address: from });
      if (balance < gas * gasPrice) throw new Error("Insufficient wallet balance for gas. Aborting.");

      const txHash = await this.wallet.sendTransaction({
        account: this.account,
        chain,
        authorizationList: [auth],
        to: from,
        data,
        value: 0n,
        gas,
      } as Parameters<typeof this.wallet.sendTransaction>[0]);
      results.push({ chainId, txHash, count: group.length });
    }
    return results;
  }

  async verify(txHash: Address, prepared: PreparedTransaction): Promise<{ success: boolean; ownerConfirmed: boolean; gasUsed?: bigint; reason?: string; ownedBefore?: bigint; ownedAfter?: bigint }> {
    const publicClient = this.publicClient(prepared.chainId);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") return { success: false, ownerConfirmed: false, reason: `transaction status ${receipt.status}` };
    const from = (prepared.from ?? this.address) as Address;
    const nft = prepared.nftContract ?? prepared.to;
    try {
      const ownedAfter = (await publicClient.readContract({
        address: nft,
        abi: ERC721_BALANCE_ABI,
        functionName: "balanceOf",
        args: [from],
      })) as bigint;
      return { success: true, ownerConfirmed: ownedAfter > 0n, gasUsed: receipt.gasUsed, ownedAfter };
    } catch {
      return { success: true, ownerConfirmed: false, gasUsed: receipt.gasUsed, reason: "balanceOf unavailable on nft contract" };
    }
  }
}
