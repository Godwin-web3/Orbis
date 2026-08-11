import { createPublicClient, http, serializeTransaction, type Address, type Chain, type PublicClient, type TransactionRequest } from "viem";
import type { PreparedTransaction } from "../domain/types";
import { chainById, RPC_ENV_BY_CHAIN_ID, MINTER_ABI } from "./executor";

const ERC721_ABI = [
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export type SignableMint = {
  from: Address;
  to: Address;
  value: bigint;
  data: `0x${string}`;
  chainId: number;
  gas: bigint;
  gasPriceWei: bigint;
  nonce: number;
  /** RLP-encoded unsigned transaction ready to sign in the user's own wallet. */
  unsignedHex: `0x${string}`;
  estimatedCostNative: string;
};

/**
 * Non-custodial execution path: the backend builds the *exact* transaction the
 * user must sign, the user signs it in their own wallet, and the backend only
 * relays the already-signed raw transaction. The backend never holds a private
 * key and never controls the user's assets.
 */
export class NonCustodialRelay {
  constructor(private readonly opts: { chainById: Map<number, Chain>; rpcEnv: Record<number, string> } = { chainById, rpcEnv: RPC_ENV_BY_CHAIN_ID }) {}

  private publicClient(chainId: number): PublicClient {
    const chain = this.opts.chainById.get(chainId);
    if (!chain) throw new Error(`No chain mapping for chainId ${chainId}`);
    const rpc = process.env[this.opts.rpcEnv[chainId]];
    if (!rpc) throw new Error(`No RPC URL configured for chainId ${chainId} (set ${this.opts.rpcEnv[chainId]})`);
    return createPublicClient({ chain, transport: http(rpc) });
  }

  /** Build the exact transaction the user must sign. Re-verifies free/open/limit first. */
  async buildMintTransaction(user: Address, prepared: PreparedTransaction): Promise<SignableMint> {
    const publicClient = this.publicClient(prepared.chainId);
    const chain = this.opts.chainById.get(prepared.chainId)!;

    await this.guardAgainstStaleMint(publicClient, prepared, user);

    const abi = (prepared.abi as unknown[] | undefined) ?? (MINTER_ABI as unknown as unknown[]);
    const owned = (await publicClient.readContract({ address: prepared.to, abi, functionName: "balanceOf", args: [user] })) as bigint;
    const limit = hasMethod(abi, "MAX_LIMIT_PER_PUBLIC_ADDRS") ? (await publicClient.readContract({ address: prepared.to, abi, functionName: "MAX_LIMIT_PER_PUBLIC_ADDRS" })) as bigint : 0n;
    if (limit !== 0n && owned + 1n > limit) throw new Error(`Per-address limit reached (${owned.toString()}/${limit.toString()}).`);

    const gas = prepared.gas > 0n ? prepared.gas : 200_000n;
    const gasPriceWei = await publicClient.getGasPrice();
    const nonce = await publicClient.getTransactionCount({ address: user, blockTag: "pending" });

    const unsignedHex = serializeTransaction({
      from: user,
      to: prepared.to,
      data: prepared.data,
      value: prepared.value,
      gas,
      gasPrice: gasPriceWei,
      nonce,
      chainId: prepared.chainId,
      type: "legacy",
    });
    const estimatedCostNative = (gas * gasPriceWei).toString();
    return { from: user, to: prepared.to, value: prepared.value, data: prepared.data, chainId: prepared.chainId, gas, gasPriceWei, nonce, unsignedHex, estimatedCostNative };
  }

  /**
   * Relay an already-signed raw transaction (produced by the user's own wallet
   * from `unsignedHex`) and verify the NFT landed in the user's wallet.
   */
  async submitSignedTransaction(user: Address, prepared: PreparedTransaction, signedRawTx: `0x${string}`): Promise<{ txHash: Address; success: boolean; ownedBefore?: bigint; ownedAfter?: bigint; gasUsed?: bigint }> {
    const publicClient = this.publicClient(prepared.chainId);
    const abi = (prepared.abi as unknown[] | undefined) ?? (MINTER_ABI as unknown as unknown[]);
    const ownedBefore = (await publicClient.readContract({ address: prepared.to, abi, functionName: "balanceOf", args: [user] })) as bigint;

    const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signedRawTx });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") return { txHash, success: false, ownedBefore, gasUsed: receipt.gasUsed };

    const ownedAfter = (await publicClient.readContract({ address: prepared.to, abi, functionName: "balanceOf", args: [user] })) as bigint;
    return { txHash, success: true, ownedBefore, ownedAfter, gasUsed: receipt.gasUsed };
  }

  private async guardAgainstStaleMint(publicClient: PublicClient, prepared: PreparedTransaction, from: Address): Promise<void> {
    const abi = (prepared.abi as unknown[] | undefined) ?? (MINTER_ABI as unknown as unknown[]);
    const args = { address: prepared.to, abi, account: from } as const;
    if (hasMethod(abi, "mintPriceInWei")) {
      const price = (await publicClient.readContract({ ...args, functionName: "mintPriceInWei" })) as bigint;
      if (price !== 0n) throw new Error(`Mint is no longer free (price=${price.toString()} wei).`);
    }
    if (hasMethod(abi, "isPublicMintOpen")) {
      const open = (await publicClient.readContract({ ...args, functionName: "isPublicMintOpen" })) as boolean;
      if (open === false) throw new Error("Mint is closed.");
    }
  }
}

function hasMethod(abi: unknown[], name: string): boolean {
  return abi.some((item) => item && typeof item === "object" && (item as { name?: string }).name === name);
}
