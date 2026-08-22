import { createPublicClient, http, encodeFunctionData, parseAbiItem, type Abi, type Address, type PublicClient } from "viem";
import type { DiscoverySource } from "../../domain/ports";
import type { MintCandidate } from "../../domain/types";
import type { BlockCursorStore } from "./block-cursor";
import type { ContractRegistry } from "./contract-registry";

// OpenSea's SeaDrop singleton — identical address across Ethereum, Base, and Robinhood
// Chain (cross-verified against two independent third-party mint tools that hardcode
// this same address, and directly against real on-chain data: 11 live mint events
// observed in a single ~50 block window on Ethereum mainnet).
export const SEADROP_ADDRESS: Address = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const OPENSEA_FEE_RECIPIENT: Address = "0x0000a26b00c1F0DF003000390027140000fAa719";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// ISeaDrop.SeaDropMint — verified by hashing the candidate signature and matching it
// byte-for-byte against the real topic0 observed via eth_getLogs against SEADROP_ADDRESS
// on Ethereum mainnet (event sig hash 0xe90cf9cc0a552cf52ea6ff74ece0f1c8ae8cc9ad630d3181f55ac43ca076b7d6).
const SEADROP_MINT_EVENT = parseAbiItem(
  "event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)"
);

const SEADROP_ABI = [
  {
    type: "function", name: "getPublicDrop", stateMutability: "view",
    inputs: [{ name: "nftContract", type: "address" }],
    outputs: [{
      type: "tuple", components: [
        { name: "mintPrice", type: "uint80" },
        { name: "startTime", type: "uint48" },
        { name: "endTime", type: "uint48" },
        { name: "maxTotalMintableByWallet", type: "uint16" },
        { name: "feeBps", type: "uint16" },
        { name: "restrictFeeRecipients", type: "bool" },
      ],
    }],
  },
  { type: "function", name: "getAllowedFeeRecipients", stateMutability: "view", inputs: [{ name: "nftContract", type: "address" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "mintPublic", stateMutability: "payable", inputs: [{ name: "nftContract", type: "address" }, { name: "feeRecipient", type: "address" }, { name: "minterIfNotPayer", type: "address" }, { name: "quantity", type: "uint256" }], outputs: [] },
] as const satisfies Abi;

const MAX_BLOCK_RANGE = 50n;

export type SeaDropDiscoveryConfig = { chainKey: string; rpcUrls: string[]; confirmations?: bigint; client?: PublicClient; cursor?: BlockCursorStore; registry?: ContractRegistry; quantity?: number };

/**
 * Watches OpenSea's SeaDrop singleton for live mint activity, then confirms each
 * contract's *current* public-drop config directly on-chain (getPublicDrop) before
 * surfacing it — only genuinely free, currently-open drops become candidates, not
 * just "something minted here recently" (price/window can change between mints).
 * Address-scoped, so it works within free RPC providers' restriction on broad
 * (address-less) log queries — see block-source.ts's doc comment for that background.
 * Runs alongside whatever DISCOVERY_MODE is configured, not instead of it: this only
 * catches SeaDrop-launched collections (a large share of real drops, not all of them).
 *
 * A contract only emits SeaDropMint when *someone else* mints it — a drop can be free
 * and open right now with nobody minting it in this particular scan's block window, and
 * without `registry` it would never resurface until its next mint. `registry`, when
 * given, remembers every contract ever seen here and re-checks all of them on every
 * scan (in addition to whatever's newly minting), so a known-but-currently-quiet drop
 * keeps being offered for as long as it stays free and open.
 */
export class SeaDropDiscoverySource implements DiscoverySource {
  readonly name = "seadrop";
  constructor(private readonly config: SeaDropDiscoveryConfig) {}

  private get clients(): PublicClient[] { return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }

  async discover(): Promise<MintCandidate[]> {
    for (const client of this.clients) {
      try {
        return await this.discoverWith(client);
      } catch (error) {
        console.error(`[${this.config.chainKey}] seadrop discovery failed:`, (error as Error).message);
      }
    }
    return [];
  }

  private async discoverWith(client: PublicClient): Promise<MintCandidate[]> {
    const latest = await client.getBlockNumber();
    const safeLatest = latest - (this.config.confirmations ?? 2n);
    const cursorKey = `seadrop:${this.config.chainKey}`;
    const stored = this.config.cursor ? await this.config.cursor.get(cursorKey) : undefined;
    const defaultStart = safeLatest > 20n ? safeLatest - 20n : 0n;
    const fromBlock = stored !== undefined && stored + 1n <= safeLatest ? stored + 1n : defaultStart;
    if (fromBlock > safeLatest) return [];
    const toBlock = fromBlock + MAX_BLOCK_RANGE - 1n < safeLatest ? fromBlock + MAX_BLOCK_RANGE - 1n : safeLatest;

    const logs = await client.getLogs({ address: SEADROP_ADDRESS, event: SEADROP_MINT_EVENT, fromBlock, toBlock });

    const registryKey = this.config.chainKey;
    const newlySeen = new Set<Address>();
    for (const log of logs) {
      if (log.args.nftContract) newlySeen.add(log.args.nftContract);
    }
    const known = this.config.registry ? await this.config.registry.list(registryKey) : [];
    const contracts = new Set<Address>([...known, ...newlySeen]);

    const candidates: MintCandidate[] = [];
    for (const nftContract of contracts) {
      const candidate = await this.candidateFor(client, nftContract);
      if (candidate) candidates.push(candidate);
    }
    if (this.config.registry) for (const contract of newlySeen) await this.config.registry.add(registryKey, contract);
    console.log(`[${this.config.chainKey}] seadrop: scanned blocks ${fromBlock}-${toBlock}, ${logs.length} mint event(s), ${newlySeen.size} new + ${known.length} known contract(s) checked, ${candidates.length} currently free+open`);

    if (this.config.cursor) await this.config.cursor.set(cursorKey, toBlock);
    return candidates;
  }

  private async candidateFor(client: PublicClient, nftContract: Address): Promise<MintCandidate | undefined> {
    try {
      const drop = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getPublicDrop", args: [nftContract] });
      // abitype decodes Solidity ints <=48 bits (startTime/endTime/maxTotalMintableByWallet
      // here, all uint48 or smaller) as `number`, and anything wider (mintPrice, uint80) as `bigint`.
      const { mintPrice, startTime, endTime, maxTotalMintableByWallet, restrictFeeRecipients } = drop;
      if (startTime === 0 && endTime === 0 && maxTotalMintableByWallet === 0) return undefined; // unset mapping entry
      if (mintPrice !== 0n) return undefined; // not free
      const now = Math.floor(Date.now() / 1000);
      if (now < startTime || (endTime !== 0 && now > endTime)) return undefined; // not currently open

      let feeRecipient: Address = OPENSEA_FEE_RECIPIENT;
      if (restrictFeeRecipients) {
        const allowed = await client.readContract({ address: SEADROP_ADDRESS, abi: SEADROP_ABI, functionName: "getAllowedFeeRecipients", args: [nftContract] });
        if (!allowed.length) return undefined; // restricted and nothing allowed — no valid call can be built
        feeRecipient = allowed[0];
      }

      const quantity = BigInt(this.config.quantity ?? 1);
      const calldata = encodeFunctionData({ abi: SEADROP_ABI, functionName: "mintPublic", args: [nftContract, feeRecipient, ZERO_ADDRESS, quantity] });

      return {
        id: `${this.config.chainKey}:seadrop:${nftContract}`,
        chainKey: this.config.chainKey,
        contract: SEADROP_ADDRESS,
        source: this.name,
        discoveredAt: new Date().toISOString(),
        mintFunction: "mintPublic",
        calldata,
        valueWei: 0n,
        maxMintsPerWallet: maxTotalMintableByWallet,
        active: true,
        eligible: true,
        metadata: {
          assetType: "nft",
          seadrop: true,
          nftContract,
          mintPrice: "0",
          startTime,
          endTime,
          maxTotalMintableByWallet,
          feeRecipient,
        },
      };
    } catch {
      return undefined; // not a SeaDrop-registered contract, or a transient RPC error
    }
  }
}
