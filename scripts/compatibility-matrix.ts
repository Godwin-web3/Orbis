import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeFunctionData, type Abi, type Address } from "viem";

type Chain = { key: string; chainId: number; rpcEnv: string; explorerApi: string; explorerUrl: string };
type Target = { name: string; chain: string; address: Address; note: string };
type Finding = { target: Target; chainId?: number; bytecode: "yes" | "no" | "error"; verifiedAbi: "yes" | "no" | "error"; nft: "yes" | "no" | "unknown"; methods: string[]; selected?: string; claimType: "none" | "merkle" | "signature" | "unknown"; calldata: "yes" | "no"; eligibility: "wallet-required" | "read-only" | "unknown"; ethCall: "pass" | "revert" | "not-run" | "rpc-error"; gasEstimate?: string; postState: "trace" | "not-available" | "not-run"; prepared: "yes-not-executable" | "no"; reason?: string };

const chains: Record<string, Chain> = {
  base: { key: "base", chainId: 8453, rpcEnv: "BASE_RPC_URL", explorerApi: "https://base.blockscout.com/api", explorerUrl: "https://basescan.org/address/" },
  ethereum: { key: "ethereum", chainId: 1, rpcEnv: "ETHEREUM_RPC_URL", explorerApi: "https://eth.blockscout.com/api", explorerUrl: "https://etherscan.io/address/" },
};

const targets: Target[] = [
  { name: "Base Mint NFT Claim", chain: "base", address: "0x87a701770996b323560e332396b33839482e2641", note: "verified claim activity" },
  { name: "Base Mint NFT", chain: "base", address: "0x831102c7eb86f9ec8f79df891bdea187d54344dd", note: "mint activity" },
  { name: "Base OpenEdition721Mint proxy", chain: "base", address: "0xfe12c6d7555b4a94b352998f8e1e96adfbe628e9", note: "verified proxy" },
  { name: "Base Free Mint NFT for Zora Airdrop", chain: "base", address: "0x7a5ee523d2935901935f6ddd95051dd109806a3e", note: "ERC-1155 token page" },
  { name: "Base Mint Podcast Collection", chain: "base", address: "0x98cac73969a5938c279366ec0533e63bd81e88b7", note: "minimal proxy" },
  { name: "Base Writing NFT", chain: "base", address: "0x61b19919617b5b51ac9903e551141e93f25ee05d", note: "ERC-721 token page" },
  { name: "Base SeaDrop clone", chain: "base", address: "0x4901ece4b99d36936a7b7110ead662ff6005eaa2", note: "ERC-1155 SeaDrop clone" },
  { name: "Base Safe Mint", chain: "base", address: "0x41b44dde7c13660ec6cec6654156d1aaa099b511", note: "safe mint activity" },
  { name: "Ethereum Mint Free Mint", chain: "ethereum", address: "0x330eb5863723937d63c63209400fcf71d1666293", note: "verified free-mint label" },
  { name: "Ethereum Mint Genesis NFT", chain: "ethereum", address: "0x8fb956ce2921954c45cb3bb41978c4c6c9736af2", note: "genesis mint activity" },
  { name: "Ethereum 10 Years Torch", chain: "ethereum", address: "0x26d85a13212433fe6a8381969c2b0db390a0b0ae", note: "free commemorative NFT" },
  { name: "Ethereum Mint NFT", chain: "ethereum", address: "0x7aab411cabc3c3691559d3dd6afc40eeeebe9da9", note: "historical free mint activity" },
  ...(process.env.MATRIX_TARGETS ?? "").split(",").filter(Boolean).map((value, index) => {
    const [chain, address] = value.split(":");
    return { name: `Custom target ${index + 1}`, chain: chain ?? "base", address: address as Address, note: "user-supplied target" };
  }),
];

const wallet = (process.env.SIMULATION_FROM ?? "0x000000000000000000000000000000000000dEaD").toLowerCase() as Address;
const traceEnabled = process.env.MATRIX_TRACE === "true";
const claimNames = /claim|proof|allow|signature|authorization|mintwithtoken|safemint|airdrop/i;
const mintNames = /mint|claim|airdrop/i;

function rpcUrl(chain: Chain) { const value = process.env[chain.rpcEnv]; if (!value) throw new Error(`${chain.rpcEnv} is not configured`); return value.split(",")[0]!.trim(); }
async function rpc(chain: Chain, method: string, params: unknown[]): Promise<any> { const response = await fetch(rpcUrl(chain), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const body = await response.json() as { result?: any; error?: { message?: string } }; if (body.error) throw new Error(body.error.message ?? "RPC error"); return body.result; }
async function getAbi(chain: Chain, address: Address): Promise<Abi | undefined> {
  const urls = [
    `${chain.explorerApi}?module=contract&action=getabi&address=${address}`,
    `https://${chain.key === "base" ? "base" : "eth"}.sourcify.dev/server/files/any/${chain.chainId}/${address}/metadata.json`,
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const body = await response.json() as { status?: string; result?: string; output?: { abi?: Abi } };
      if (body.result) { try { return JSON.parse(body.result) as Abi; } catch {} }
      if (body.output?.abi) return body.output.abi;
    } catch {}
  }
  return undefined;
}
function word(value: string) { return value.slice(2).padStart(64, "0"); }
function sample(type: string, name: string): unknown { if (type === "address") return wallet; if (type === "uint256" || type === "uint128" || type === "uint64" || type === "uint32" || type === "uint16" || type === "uint8") return 1n; if (type === "bool") return false; if (type === "bytes32") return `0x${"00".repeat(32)}`; if (type === "bytes") return "0x"; if (type.endsWith("[]")) return []; if (type === "string") return ""; return undefined; }
function pickMethod(abi: Abi): any | undefined { const methods = abi.filter((item) => item.type === "function" && mintNames.test(item.name ?? "")); return methods.find((item: any) => item.name === "claim") ?? methods.find((item: any) => item.name === "freeMint") ?? methods.find((item: any) => item.name === "mint") ?? methods[0]; }
function claimType(fragment: any): Finding["claimType"] { if (!fragment) return "none"; const inputs = fragment.inputs ?? []; if (inputs.some((input: any) => input.type === "bytes32[]" || /proof|merkle/i.test(input.name ?? ""))) return "merkle"; if (inputs.some((input: any) => input.type === "bytes" && /sig|auth/i.test(input.name ?? ""))) return "signature"; return inputs.some((input: any) => claimNames.test(input.name ?? "")) ? "unknown" : "none"; }
function isNftResult(value: string | undefined): Finding["nft"] { if (!value) return "unknown"; return value !== "0x" && BigInt(value) !== 0n ? "yes" : "no"; }

async function inspect(target: Target): Promise<Finding> {
  const chain = chains[target.chain]!;
  const base: Finding = { target, bytecode: "error", verifiedAbi: "error", nft: "unknown", methods: [], claimType: "none", calldata: "no", eligibility: "unknown", ethCall: "not-run", postState: "not-run", prepared: "no" };
  try {
    const code = await rpc(chain, "eth_getCode", [target.address, "latest"]); base.bytecode = code && code !== "0x" ? "yes" : "no";
    const abi = await getAbi(chain, target.address); base.verifiedAbi = abi ? "yes" : "no";
    if (!abi) { base.reason = "no public verified ABI from Blockscout"; return base; }
    const methods = abi.filter((item: any) => item.type === "function" && mintNames.test(item.name ?? ""));
    base.methods = methods.map((item: any) => `${item.name}(${(item.inputs ?? []).map((input: any) => input.type).join(",")})`);
    const fragment = pickMethod(abi); base.selected = fragment ? `${fragment.name}(${(fragment.inputs ?? []).map((input: any) => input.type).join(",")})` : undefined; base.claimType = claimType(fragment);
    try { base.nft = isNftResult(await rpc(chain, "eth_call", [{ to: target.address, data: `0x01ffc9a780ac58cd${"00".repeat(28)}` }, "latest"])); } catch { base.nft = "unknown"; }
    base.eligibility = wallet === "0x000000000000000000000000000000000000dead" ? "wallet-required" : "read-only";
    if (!fragment) { base.reason = "verified ABI has no mint-like function"; return base; }
    const args = (fragment.inputs ?? []).map((input: any) => sample(input.type, input.name ?? ""));
    if (args.some((arg: unknown) => arg === undefined)) { base.reason = "unsupported ABI argument type"; return base; }
    try {
      const data = encodeFunctionData({ abi: [fragment], functionName: fragment.name, args }) as `0x${string}`; base.calldata = "yes";
      const tx = { from: wallet, to: target.address, data, value: "0x0" };
      try { base.gasEstimate = String(BigInt(await rpc(chain, "eth_estimateGas", [tx]))); } catch (error) { base.ethCall = "rpc-error"; base.reason = `eth_estimateGas: ${String(error).slice(0, 180)}`; return base; }
      try { await rpc(chain, "eth_call", [tx, "latest"]); base.ethCall = "pass"; } catch (error) { base.ethCall = "revert"; base.reason = `eth_call: ${String(error).slice(0, 180)}`; return base; }
      if (traceEnabled) { try { await rpc(chain, "debug_traceCall", [tx, "latest", { tracer: "callTracer", tracerConfig: { withLog: true } }]); base.postState = "trace"; } catch { base.postState = "not-available"; } } else base.postState = "not-available";
      base.prepared = "yes-not-executable"; base.reason = base.postState === "not-available" ? "call succeeds, but no post-state proof; prepared only" : "prepared after read-only simulation";
    } catch (error) { base.reason = `calldata: ${String(error).slice(0, 180)}`; }
  } catch (error) { base.reason = String(error).slice(0, 180); }
  return base;
}

function md(value: unknown) { return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " "); }
const findings = await Promise.all(targets.map(inspect));
await mkdir("reports", { recursive: true });
const rows = findings.map((item) => `| ${item.target.chain} | [${item.target.name}](${chains[item.target.chain]!.explorerUrl}${item.target.address}) | ${item.bytecode} | ${item.verifiedAbi} | ${item.nft} | ${md(item.selected)} | ${item.claimType} | ${item.calldata} | ${item.eligibility} | ${item.ethCall} | ${item.gasEstimate ?? "—"} | ${item.postState} | ${item.prepared} | ${md(item.reason)} |`).join("\n");
const summary = { total: findings.length, verifiedAbi: findings.filter((item) => item.verifiedAbi === "yes").length, calldata: findings.filter((item) => item.calldata === "yes").length, simulated: findings.filter((item) => item.ethCall === "pass").length, prepared: findings.filter((item) => item.prepared !== "no").length, blocked: findings.filter((item) => item.prepared === "no").length };
const report = `# Real-contract compatibility matrix\n\nGenerated: ${new Date().toISOString()}\n\nThe matrix is read-only. The sender is ${wallet}. No transaction was signed or broadcast. A prepared transaction is explicitly marked \`yes-not-executable\` because the current executor is not connected and a successful \`eth_call\` is not post-state proof.\n\n## Summary\n\n- Contracts checked: ${summary.total}\n- Public verified ABIs: ${summary.verifiedAbi}\n- Calldata constructed: ${summary.calldata}\n- eth_call simulations passed: ${summary.simulated}\n- Prepared but not executable: ${summary.prepared}\n- Blocked before preparation: ${summary.blocked}\n\n## Matrix\n\n| Chain | Contract | Bytecode | ABI | NFT | Selected method | Claim | Calldata | Eligibility | eth_call | Gas | Post-state | Prepared | Reason |\n|---|---|---:|---:|---:|---|---|---:|---|---|---|---:|---|---|---|\n${rows}\n\n## Interpretation\n\nThis is a compatibility report, not an approval to execute. Contracts requiring a wallet-specific allowlist, Merkle proof, EIP-712 authorization, unusual ABI arguments, or trace/state-diff evidence remain blocked.\n`;
await Bun.write("reports/compatibility-matrix.md", report);
console.log(JSON.stringify({ summary, report: "reports/compatibility-matrix.md" }, null, 2));
