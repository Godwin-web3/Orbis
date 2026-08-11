import ganache from "ganache";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ContractArtifact } from "./compiler";

export async function startLab(artifacts: Record<string, ContractArtifact>, options: { port?: number; forkUrl?: string } = {}) {
  const port = options.port ?? 8547;
  const server = ganache.server({ logging: { quiet: true }, wallet: { totalAccounts: 5, defaultBalance: 1000 }, chain: { chainId: 31337, hardfork: "shanghai", vmErrorsOnRPCResponse: true }, ...(options.forkUrl ? { fork: { url: options.forkUrl } } : {}) });
  await server.listen(port);
  const transport = http(`http://127.0.0.1:${port}`);
  const chain = { id: 31337, name: "Mint Lab", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } } as const;
  const publicClient = createPublicClient({ chain, transport });
  const accounts = server.provider.getInitialAccounts();
  const keys = Object.values(accounts).map((account: any) => account.secretKey as Hex);
  const deployer = privateKeyToAccount(keys[0]!);
  const wallet = createWalletClient({ account: deployer, chain, transport });
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Address> {
    const spec = artifacts[name];
    if (!spec) throw new Error(`unknown lab contract ${name}`);
    const hash = await wallet.deployContract({ abi: spec.abi, bytecode: spec.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deployment failed for ${name}`);
    return receipt.contractAddress;
  }
  async function close() { await server.close(); }
  return { server, port, publicClient, wallet, deployer, deploy, close, artifacts };
}
