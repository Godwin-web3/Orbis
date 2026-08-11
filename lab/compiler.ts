import solc from "solc";
import { readFile } from "node:fs/promises";

export type ContractArtifact = { abi: any[]; bytecode: `0x${string}` };

export async function compileLab(): Promise<Record<string, ContractArtifact>> {
  const source = await readFile("contracts/AdversarialMintLab.sol", "utf8");
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "AdversarialMintLab.sol": { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  if (errors.length) throw new Error(errors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n"));
  return Object.fromEntries(Object.entries(output.contracts["AdversarialMintLab.sol"]).map(([name, value]: [string, any]) => [name, { abi: value.abi, bytecode: `0x${value.evm.bytecode.object}` }]));
}
