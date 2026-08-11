import type { Abi } from "viem";

export const nftDetectionAbi = [
  { type: "function", name: "supportsInterface", stateMutability: "view", inputs: [{ name: "interfaceId", type: "bytes4" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "freeMint", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "publicMint", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "payable", inputs: [{ name: "quantity", type: "uint256" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "payable", inputs: [], outputs: [] },
] as const satisfies Abi;
