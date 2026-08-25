import { createPublicClient, encodeFunctionData, http, type Address, type PublicClient } from "viem";
import type { DropStatus, MintCandidate } from "../../domain/types";
import type { DropStatusStore } from "../../domain/ports";

export const HOODSEA_LAUNCHPAD: Address = "0xa1e9DAB10a4DED224c090c73B09b6658Cc69331b";

export const HOODSEA_LAUNCHPAD_ABI = [
  { type: "function", name: "getAllCollections", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getCollectionCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isCollection", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export const HOODSEA_NFT_ABI = [
  { type: "function", name: "totalMinted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getMintStatus", stateMutability: "view", inputs: [], outputs: [
    { name: "isOpen", type: "bool" },
    { name: "isScheduled", type: "bool" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "minted", type: "uint256" },
    { name: "remaining", type: "uint256" },
    { name: "bonded", type: "bool" },
  ] },
  { type: "function", name: "info", stateMutability: "view", inputs: [], outputs: [
    { name: "name", type: "string" },
    { name: "ticker", type: "string" },
    { name: "bio", type: "string" },
    { name: "socialX", type: "string" },
    { name: "socialGithub", type: "string" },
    { name: "socialFarcaster", type: "string" },
    { name: "photoURIs", type: "string[6]" },
    { name: "photoCount", type: "uint8" },
    { name: "creator", type: "address" },
    { name: "mintPrice", type: "uint256" },
    { name: "platformFeeETH", type: "uint256" },
    { name: "bondingComplete", type: "bool" },
    { name: "tokenAddress", type: "address" },
    { name: "tokenEnabled", type: "bool" },
    { name: "tokenFeeBps", type: "uint256" },
  ] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [
    { name: "quantity", type: "uint256" },
    { name: "proof", type: "bytes32[]" },
  ], outputs: [] },
] as const;

export function encodeHoodseaMint(quantity = 1n): `0x${string}` {
  return encodeFunctionData({ abi: HOODSEA_NFT_ABI, functionName: "mint", args: [quantity, []] });
}

export type HoodseaLive = {
  collection: Address;
  name: string;
  mintPrice: bigint;
  platformFee: bigint;
  minted: number;
  remaining: number;
  startTime: number;
  endTime: number;
  bonded: boolean;
  open: boolean;
};

export function hoodseaIsLiveFree(live: HoodseaLive, now = Math.floor(Date.now() / 1000)): boolean {
  if (live.bonded || live.remaining <= 0) return false;
  if (live.mintPrice !== 0n || live.platformFee !== 0n) return false;
  if (live.endTime !== 0 && now > live.endTime) return false;
  if (live.startTime !== 0 && now < live.startTime && !live.open) return false;
  return live.open || (live.startTime !== 0 && now >= live.startTime);
}

export async function readHoodseaLive(client: PublicClient, collection: Address): Promise<HoodseaLive | undefined> {
  try {
    const [info, status] = await Promise.all([
      client.readContract({ address: collection, abi: HOODSEA_NFT_ABI, functionName: "info" }),
      client.readContract({ address: collection, abi: HOODSEA_NFT_ABI, functionName: "getMintStatus" }),
    ]);
    return {
      collection,
      name: info[0],
      mintPrice: info[9],
      platformFee: info[10],
      minted: Number(status[4]),
      remaining: Number(status[5]),
      startTime: Number(status[2]),
      endTime: Number(status[3]),
      bonded: status[6],
      open: status[0],
    };
  } catch {
    return undefined;
  }
}

export type HoodseaSourceConfig = {
  chainKey: string;
  rpcUrls: string[];
  client?: PublicClient;
  dropStatusStore?: DropStatusStore;
  maxCollections?: number;
};

export class HoodseaDiscoverySource {
  readonly name = "hoodsea";
  constructor(private readonly config: HoodseaSourceConfig) {}

  private get clients(): PublicClient[] {
    return this.config.client ? [this.config.client] : this.config.rpcUrls.map((url) => createPublicClient({ transport: http(url) }));
  }

  async discover(): Promise<MintCandidate[]> {
    if (this.config.chainKey !== "robinhood") return [];
    for (const client of this.clients) {
      try {
        return await this.discoverWith(client);
      } catch (error) {
        console.error(`[${this.config.chainKey}] hoodsea discovery failed:`, (error as Error).message);
      }
    }
    return [];
  }

  private async discoverWith(client: PublicClient): Promise<MintCandidate[]> {
    const all = await client.readContract({ address: HOODSEA_LAUNCHPAD, abi: HOODSEA_LAUNCHPAD_ABI, functionName: "getAllCollections" });
    const limit = this.config.maxCollections ?? Number(process.env.HOODSEA_MAX_COLLECTIONS ?? "25");
    const collections = all.slice(-limit);
    const out: MintCandidate[] = [];
    for (const collection of collections) {
      const live = await readHoodseaLive(client, collection);
      if (!live) continue;
      const now = Math.floor(Date.now() / 1000);
      const status: DropStatus["status"] = live.bonded || live.remaining <= 0
        ? "ended"
        : live.mintPrice !== 0n || live.platformFee !== 0n
          ? "live_paid"
          : live.startTime !== 0 && now < live.startTime && !live.open
            ? "upcoming"
            : hoodseaIsLiveFree(live, now)
              ? "live_free"
              : "unavailable";
      await this.saveStatus(collection, status, live);
      if (status !== "live_free") continue;
      out.push({
        id: `${this.config.chainKey}:hoodsea:${collection}`,
        chainKey: this.config.chainKey,
        contract: collection,
        source: this.name,
        discoveredAt: new Date().toISOString(),
        mintFunction: "mint",
        calldata: encodeHoodseaMint(1n),
        valueWei: 0n,
        active: true,
        eligible: true,
        metadata: {
          assetType: "nft",
          launchpad: "hoodsea",
          launchpadVerified: true,
          nftContract: collection,
          name: live.name,
          recentMints: live.minted,
          valueSignal: live.minted >= 1,
          mintPrice: "0",
          startTime: live.startTime,
          endTime: live.endTime,
          mintUrl: "https://hoodsea.com",
        },
      });
    }
    console.log(`[${this.config.chainKey}] hoodsea: checked ${collections.length}/${all.length} collection(s), ${out.length} live free`);
    return out;
  }

  private async saveStatus(collection: Address, status: DropStatus["status"], live: HoodseaLive): Promise<void> {
    if (!this.config.dropStatusStore) return;
    await this.config.dropStatusStore.save({
      id: `${this.config.chainKey}:${collection}`,
      chainKey: this.config.chainKey,
      nftContract: collection,
      source: this.name,
      status,
      name: live.name,
      mintPriceWei: (live.mintPrice + live.platformFee).toString(),
      startTime: live.startTime,
      endTime: live.endTime,
      maxTotalMintableByWallet: 0,
      checkedAt: new Date().toISOString(),
    });
  }
}
