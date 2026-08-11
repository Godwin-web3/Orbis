import { decodeFunctionData, encodeFunctionData, type Abi, type Address } from "viem";
import type { CalldataBuilder } from "../../domain/ports";
import type { MintCandidate, TransactionRequest } from "../../domain/types";

const fallbackAbi = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "publicMint", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "publicMint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "freeMint", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "claim", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "payable", inputs: [], outputs: [] },
] as const satisfies Abi;

function candidateAbi(candidate: MintCandidate): Abi { return Array.isArray(candidate.metadata.abi) ? candidate.metadata.abi as Abi : fallbackAbi; }
function configuredArgs(candidate: MintCandidate): unknown[] | undefined { return Array.isArray(candidate.metadata.args) ? [...candidate.metadata.args] : undefined; }
function fragmentFor(candidate: MintCandidate, abi: Abi) {
  const name = candidate.mintFunction;
  if (!name) return undefined;
  const fragments = abi.filter((item) => item.type === "function" && item.name === name);
  if (!fragments.length) return undefined;
  const args = configuredArgs(candidate);
  if (args) return fragments.find((item) => item.type === "function" && item.inputs.length === args.length);
  if (candidate.metadata.quantity !== undefined) return fragments.find((item) => item.type === "function" && item.inputs.length > 0) ?? fragments[0];
  return fragments.find((item) => item.type === "function" && item.inputs.length === 0) ?? fragments[0];
}

export function buildMintCalldata(candidate: MintCandidate): `0x${string}` | undefined {
  if (candidate.calldata) return candidate.calldata;
  const abi = candidateAbi(candidate);
  const fragment = fragmentFor(candidate, abi);
  if (!fragment || fragment.type !== "function") return undefined;
  const configured = configuredArgs(candidate);
  const args = configured ?? (fragment.inputs.length ? [BigInt(candidate.metadata.quantity === undefined ? 1 : Number(candidate.metadata.quantity))] : []);
  if (args.length !== fragment.inputs.length) return undefined;
  try { return encodeFunctionData({ abi: [fragment], functionName: fragment.name, args }) as `0x${string}`; } catch { return undefined; }
}

export class DefaultCalldataBuilder implements CalldataBuilder {
  async build(candidate: MintCandidate): Promise<TransactionRequest> { const data = buildMintCalldata(candidate); if (!data) throw new Error(`unable to build calldata for ${candidate.id}`); return { chainKey: candidate.chainKey, to: candidate.contract, data, value: candidate.valueWei, from: candidate.from }; }
}

export function detectMintFunction(bytecode: `0x${string}`): string[] {
  const found: string[] = [];
  for (const item of fallbackAbi) { if (item.type !== "function") continue; try { const data = encodeFunctionData({ abi: [item], functionName: item.name, args: item.inputs.length ? [1n] : [] }); if (bytecode.includes(data.slice(2, 10))) found.push(item.name); } catch {} }
  return [...new Set(found)];
}
export function identifyCandidate(contract: Address, chainKey: string, source: string, mintFunction: string): MintCandidate { return { id: `${chainKey}:${contract}:${mintFunction}`, chainKey, contract, source, discoveredAt: new Date().toISOString(), mintFunction, valueWei: 0n, metadata: { assetType: "nft" } }; }
export function decodeMintCalldata(data: `0x${string}`) { try { return decodeFunctionData({ abi: fallbackAbi, data }); } catch { return undefined; } }
