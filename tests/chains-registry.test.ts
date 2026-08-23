import { describe, expect, test } from "bun:test";
import { capitalize, chainNameFor, dropLink } from "../src/chains/registry";

describe("capitalize", () => {
  test("uppercases the first letter only", () => {
    expect(capitalize("robinhood")).toBe("Robinhood");
    expect(capitalize("base")).toBe("Base");
  });
});

describe("chainNameFor", () => {
  test("resolves a configured chain's numeric chainId to its readable name", () => {
    expect(chainNameFor(1)).toBe("Ethereum");
    expect(chainNameFor(8453)).toBe("Base");
    expect(chainNameFor(4663)).toBe("Robinhood");
  });
  test("falls back to the raw id for an unconfigured chainId", () => {
    expect(chainNameFor(999999)).toBe("chain 999999");
  });
});

describe("dropLink", () => {
  test("builds an OpenSea link when the chain has an OpenSea slug", () => {
    expect(dropLink("ethereum", "0xabc")).toBe("https://opensea.io/assets/ethereum/0xabc");
  });
  test("falls back to the block explorer when OpenSea doesn't cover the chain", () => {
    expect(dropLink("sepolia", "0xabc")).toBe("https://sepolia.etherscan.io/address/0xabc");
  });
  test("returns undefined for an unknown chain", () => {
    expect(dropLink("nope", "0xabc")).toBeUndefined();
  });
});
