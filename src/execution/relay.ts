import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, type Address, type Chain, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PreparedTransaction } from "../domain/types";
import { chainById, RPC_ENV_BY_CHAIN_ID, MINTER_ABI } from "./executor";

const ERC721_ABI = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 tokenId) external",
  "function balanceOf(address owner) external view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export type FleetWallet = { account: ReturnType<typeof privateKeyToAccount>; wallet: WalletClient; address: Address };
export type RelayResult = { user: Address; mintWallet: Address; mintTx: Address; tokenId?: bigint; transferTx?: Address };

/**
 * A set of funded bot wallets used to mint on behalf of end users. Each mint is
 * paid for and signed by a fleet wallet; the resulting NFT is then transferred
 * to the requesting user. Users never hold or reveal private keys.
 */
export class WalletFleet {
  private readonly wallets: FleetWallet[] = [];

  constructor(keys: string[]) {
    for (const key of keys) {
      const account = privateKeyToAccount(key as `0x${string}`);
      const wallet = createWalletClient({ account, transport: http() });
      this.wallets.push({ account, wallet, address: account.address });
    }
  }

  get addresses(): Address[] { return this.wallets.map((wallet) => wallet.address); }
  get size(): number { return this.wallets.length; }

  /** Round-robin pick a wallet that still has per-address headroom on the mint contract. */
  async pickFor(chainId: number, contract: Address, maxPerWallet: bigint): Promise<FleetWallet | null> {
    const publicClient = this.publicClient(chainId);
    for (const wallet of this.wallets) {
      let owned = 0n;
      try {
        owned = (await publicClient.readContract({ address: contract, abi: MINTER_ABI, functionName: "balanceOf", args: [wallet.address] })) as bigint;
      } catch {
        owned = 0n;
      }
      if (maxPerWallet === 0n || owned < maxPerWallet) return wallet;
    }
    return null;
  }

  private readonly publicClients = new Map<number, PublicClient>();
  publicClient(chainId: number): PublicClient {
    let client = this.publicClients.get(chainId);
    if (!client) {
      const chain = chainById.get(chainId);
      if (!chain) throw new Error(`No chain mapping for chainId ${chainId}`);
      const rpc = process.env[RPC_ENV_BY_CHAIN_ID[chainId]];
      if (!rpc) throw new Error(`No RPC URL configured for chainId ${chainId} (set ${RPC_ENV_BY_CHAIN_ID[chainId]})`);
      client = createPublicClient({ chain, transport: http(rpc) });
      this.publicClients.set(chainId, client);
    }
    return client;
  }
}

/**
 * Custodial relay: mints from a fleet wallet (paying gas, clearing the contract's
 * per-wallet cap against the bot), then transfers the NFT to the end user. The
 * user supplies only their public receive address — no private key, no wallet.
 */
export class MintRelay {
  constructor(
    private readonly fleet: WalletFleet,
    private readonly opts: { gasPriceBump?: bigint } = {},
  ) {}

  get fleetSize(): number { return this.fleet.size; }
  get fleetAddresses(): Address[] { return this.fleet.addresses; }

  /** Mint one prepared NFT and transfer it to `user`. Returns routing + verification. */
  async mintFor(user: Address, prepared: PreparedTransaction): Promise<RelayResult> {
    const chainId = prepared.chainId;
    const publicClient = this.fleet.publicClient(chainId);
    const chain = chainById.get(chainId)!;

    const maxPerWallet = (prepared.abi as unknown[] | undefined) && hasMethod(prepared.abi as unknown[], "MAX_LIMIT_PER_PUBLIC_ADDRS")
      ? (await publicClient.readContract({ address: prepared.to, abi: prepared.abi as unknown[], functionName: "MAX_LIMIT_PER_PUBLIC_ADDRS" })) as bigint
      : 0n;

    const mintWallet = await this.fleet.pickFor(chainId, prepared.to, maxPerWallet);
    if (!mintWallet) throw new Error("No fleet wallet has per-address headroom on this mint contract.");

    await this.guardAgainstStaleMint(publicClient, prepared, mintWallet.address);

    const balanceBefore = (await publicClient.readContract({ address: prepared.to, abi: prepared.abi as unknown[], functionName: "balanceOf", args: [mintWallet.address] })) as bigint;

    const gas = prepared.gas > 0n ? prepared.gas : 200_000n;
    const gasPrice = await publicClient.getGasPrice();
    const estCost = gas * gasPrice;
    const balance = await publicClient.getBalance({ address: mintWallet.address });
    if (balance < estCost) throw new Error(`Fleet wallet ${mintWallet.address} lacks gas (need ${estCost}, have ${balance}).`);

    const mintTx = await mintWallet.wallet.sendTransaction({ account: mintWallet.account, chain, to: prepared.to, data: prepared.data, value: prepared.value, gas });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Mint tx failed (status=${receipt.status}).`);

    const balanceAfter = (await publicClient.readContract({ address: prepared.to, abi: prepared.abi as unknown[], functionName: "balanceOf", args: [mintWallet.address] })) as bigint;
    if (balanceAfter <= balanceBefore) throw new Error("Mint succeeded but no NFT was received by the fleet wallet.");

    const index = balanceBefore;
    const tokenId = (await publicClient.readContract({ address: prepared.to, abi: ERC721_ABI, functionName: "tokenOfOwnerByIndex", args: [mintWallet.address, index] })) as bigint;

    const transferData = encodeFunctionData({ abi: ERC721_ABI, functionName: "safeTransferFrom", args: [mintWallet.address, user, tokenId] });
    const transferTx = await mintWallet.wallet.sendTransaction({ account: mintWallet.account, chain, to: prepared.to, data: transferData, value: 0n });

    const result: RelayResult = { user, mintWallet: mintWallet.address, mintTx, tokenId, transferTx };
    return result;
  }

  private async guardAgainstStaleMint(publicClient: PublicClient, prepared: PreparedTransaction, from: Address): Promise<void> {
    const abi = (prepared.abi as unknown[] | undefined) ?? (MINTER_ABI as unknown as unknown[]);
    const args = { address: prepared.to, abi, account: from } as const;
    if (hasMethod(abi, "mintPriceInWei")) {
      const price = (await publicClient.readContract({ ...args, functionName: "mintPriceInWei" })) as bigint;
      if (price !== 0n) throw new Error(`Mint is no longer free (price=${price.toString()} wei). Aborting.`);
    }
    if (hasMethod(abi, "isPublicMintOpen")) {
      const open = (await publicClient.readContract({ ...args, functionName: "isPublicMintOpen" })) as boolean;
      if (open === false) throw new Error("Mint is closed. Aborting.");
    }
  }
}

function hasMethod(abi: unknown[], name: string): boolean {
  return abi.some((item) => item && typeof item === "object" && (item as { name?: string }).name === name);
}
