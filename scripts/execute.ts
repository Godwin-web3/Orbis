import { createPublicClient, createWalletClient, http, parseEther, formatEther, encodeFunctionData, type Address, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = process.env.SEPOLIA_RPC_URL ?? process.env.TESTNET_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CONTRACT = (process.env.TARGET_CONTRACT ?? "0x8Ad8867126e7F541f6a16609B8263D043d6647f4") as Address;
const MINT_FUNCTION = process.env.MINT_FUNCTION ?? "publicMint";
const QUANTITY = BigInt(process.env.MINT_QUANTITY ?? "1");

const privKey = process.env.EXECUTION_PRIVATE_KEY;
if (!privKey) throw new Error("Set the EXECUTION_PRIVATE_KEY environment variable. Refusing to sign without a key.");
if (process.env.EXECUTION_ACK?.toLowerCase() !== "true") throw new Error("Set EXECUTION_ACK=true to authorize a live broadcast on Sepolia testnet.");

const abi: Abi = [
  { inputs: [{ name: "_quantity", type: "uint256" }], name: "publicMint", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [], name: "mintPriceInWei", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "isPublicMintOpen", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "MAX_LIMIT_PER_PUBLIC_ADDRS", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

const account = privateKeyToAccount(privKey as `0x${string}`);
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
const walletClient = createWalletClient({ chain: sepolia, transport: http(RPC), account });

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 11155111) throw new Error(`Refusing to run on chain ${chainId}; expected Sepolia (11155111).`);
  const from = account.address;
  const [bal, price, open, owned, limit, block] = await Promise.all([
    publicClient.getBalance({ address: from }),
    publicClient.readContract({ address: CONTRACT, abi, functionName: "mintPriceInWei" }),
    publicClient.readContract({ address: CONTRACT, abi, functionName: "isPublicMintOpen" }),
    publicClient.readContract({ address: CONTRACT, abi, functionName: "balanceOf", args: [from] }),
    publicClient.readContract({ address: CONTRACT, abi, functionName: "MAX_LIMIT_PER_PUBLIC_ADDRS" }),
    publicClient.getBlockNumber(),
  ]);

  console.log("chainId:", chainId, "| block:", block.toString());
  console.log("wallet:", from, "| balance:", formatEther(bal), "ETH");
  console.log("contract:", CONTRACT);
  console.log("mintPriceInWei:", price.toString(), "| public mint open:", open, "| owned:", owned.toString(), "/", limit.toString());

  if (price !== 0n) throw new Error(`Mint is NOT free (price=${price.toString()} wei). Aborting.`);
  if (!open) throw new Error("Public mint is closed. Aborting.");
  if (owned + QUANTITY > limit) throw new Error("Would exceed per-address mint limit. Aborting.");

  const data = encodeFunctionData({ abi, functionName: MINT_FUNCTION, args: [QUANTITY] });
  const gas = await publicClient.estimateGas({ account: from, to: CONTRACT, data, value: 0n });
  const gasPrice = await publicClient.getGasPrice();
  const cost = gas * gasPrice;
  console.log("calldata:", data, "| qty:", QUANTITY.toString());
  console.log("gas:", gas.toString(), "| gasPrice:", formatEther(gasPrice), "ETH | est cost:", formatEther(cost), "ETH");

  if (bal < cost) throw new Error("Insufficient wallet balance for gas. Aborting.");

  try {
    await publicClient.call({ account: from, to: CONTRACT, data, value: 0n });
  } catch (simErr) {
    throw new Error(`eth_call simulation reverted: ${(simErr as Error).shortMessage ?? (simErr as Error).message}. Aborting broadcast.`);
  }
  console.log("simulation OK (eth_call succeeded)");

  console.log("Broadcasting publicMint(1) ...");
  const txHash = await walletClient.sendTransaction({ to: CONTRACT, data, value: 0n, gas, gasPrice });
  console.log("TX HASH:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  console.log("status:", receipt.status, "| gasUsed:", receipt.gasUsed?.toString(), "| block:", receipt.blockNumber?.toString());
  if (receipt.status !== "success") throw new Error(`Transaction failed (status=${receipt.status}).`);

  const after = await publicClient.readContract({ address: CONTRACT, abi, functionName: "balanceOf", args: [from] });
  console.log("NFT balance after:", after.toString(), "(before:", owned.toString() + ")");
  console.log("RESULT: SUCCESS — minted", (after - owned).toString(), "NFT to", from);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", (e as Error).message); process.exit(1); });
