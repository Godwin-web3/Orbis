import { compileLab } from "./compiler";
import { startLab } from "./runtime";

const artifacts = await compileLab();
const lab = await startLab(artifacts, { port: Number(process.env.LAB_PORT ?? 8547), forkUrl: process.env.LAB_FORK_URL });
const nft = await lab.deploy("LabNFT");
const token = await lab.deploy("LabERC20", [lab.deployer.address, 10n]);
const now = BigInt(Math.floor(Date.now() / 1000));
await lab.wallet.writeContract({ address: token, abi: artifacts.LabERC20.abi, functionName: "approve", args: [nft, 10n] });
await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "configure", args: [now - 10n, now + 3600n, token, "0x0000000000000000000000000000000000000000", false, false, false, lab.deployer.address, 0n] });
await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "setQuota", args: [lab.deployer.address, 1n] });
const hash = await lab.wallet.writeContract({ address: nft, abi: artifacts.LabNFT.abi, functionName: "mint", value: 0n });
const receipt = await lab.publicClient.waitForTransactionReceipt({ hash });
console.log(JSON.stringify({ rpc: `http://127.0.0.1:${lab.port}`, nft, token, wallet: lab.deployer.address, mintTx: hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), forked: Boolean(process.env.LAB_FORK_URL) }));
await lab.close();
