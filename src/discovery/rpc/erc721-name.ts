import type { Abi, Address, PublicClient } from "viem";

// Standard ERC-721 metadata extension — part of the spec, but technically optional, so
// contracts that skip it are read with a try/catch rather than assumed to implement it.
const ERC721_NAME_ABI = [{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const satisfies Abi;

export async function readErc721Name(client: PublicClient, contract: Address): Promise<string | undefined> {
  try {
    const name = await client.readContract({ address: contract, abi: ERC721_NAME_ABI, functionName: "name" });
    return name || undefined;
  } catch {
    return undefined;
  }
}
