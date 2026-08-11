import { createPublicClient, http, type Abi, type Address, type PublicClient } from "viem";
import type { ContractInspector } from "../../domain/ports";
import type { EligibilitySnapshot, MintCandidate } from "../../domain/types";

const abi = [
  { type: "function", name: "maxPerWallet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxMintPerWallet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintedPerWallet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "numberMinted", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintStart", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintEnd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "publicMintOpen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

async function read(client: PublicClient, address: Address, functionName: string, args?: readonly unknown[]): Promise<unknown> {
  try { return await client.readContract({ address, abi, functionName: functionName as never, args: args as never }); } catch { return undefined; }
}

export class EvmEligibilityInspector implements ContractInspector {
  constructor(private readonly rpcUrls: string[], private readonly wallet?: Address, private readonly client?: PublicClient) {}
  private get clients(): PublicClient[] { return this.client ? [this.client] : this.rpcUrls.map((url) => createPublicClient({ transport: http(url) })); }
  async inspect(candidate: MintCandidate): Promise<MintCandidate> {
    if (!this.wallet) return candidate;
    for (const client of this.clients) {
      try {
        const block = await client.getBlock();
        const [maxPerWallet, mintedByWallet, totalSupply, maxSupply, startTimestamp, endTimestamp, publicMintOpen] = await Promise.all([
          read(client, candidate.contract, "maxPerWallet", [this.wallet]).then((v) => v ?? read(client, candidate.contract, "maxMintPerWallet", [this.wallet])),
          read(client, candidate.contract, "mintedPerWallet", [this.wallet]).then((v) => v ?? read(client, candidate.contract, "numberMinted", [this.wallet])),
          read(client, candidate.contract, "totalSupply"), read(client, candidate.contract, "maxSupply"), read(client, candidate.contract, "mintStart"), read(client, candidate.contract, "mintEnd"), read(client, candidate.contract, "publicMintOpen"),
        ]);
        const now = BigInt(block.timestamp);
        const start = asBigint(startTimestamp); const end = asBigint(endTimestamp);
        const max = asBigint(maxPerWallet); const minted = asBigint(mintedByWallet);
        const active = (start === undefined || now >= start) && (end === undefined || end === 0n || now <= end) && publicMintOpen !== false;
        const eligible = active && (max === undefined || minted === undefined || minted < max);
        const eligibility: EligibilitySnapshot = { checkedAt: new Date().toISOString(), wallet: this.wallet, active, eligible, maxPerWallet: max?.toString(), mintedByWallet: minted?.toString(), totalSupply: asBigint(totalSupply)?.toString(), maxSupply: asBigint(maxSupply)?.toString(), startTimestamp: start?.toString(), endTimestamp: end?.toString(), reason: eligible ? undefined : "wallet quota or mint window check failed" };
        return { ...candidate, active, eligible, eligibility };
      } catch {}
    }
    return candidate;
  }
}

function asBigint(value: unknown): bigint | undefined { return typeof value === "bigint" ? value : typeof value === "number" || typeof value === "string" ? BigInt(value) : undefined; }
