import { describe, expect, test } from "bun:test";
import { parseTargetInput } from "../src/discovery/target";

const ADDRESS = "0x1234567890123456789012345678901234567890";

describe("parseTargetInput", () => {
  test("parses a bare address using the default chain", () => {
    expect(parseTargetInput(ADDRESS, "base")).toEqual({ chainKey: "base", contract: ADDRESS });
  });

  test("returns undefined for a bare address with no default chain", () => {
    expect(parseTargetInput(ADDRESS)).toBeUndefined();
  });

  test("parses an OpenSea asset URL with an explicit chain slug", () => {
    expect(parseTargetInput(`https://opensea.io/assets/base/${ADDRESS}/1`, "ethereum")).toEqual({ chainKey: "base", contract: ADDRESS });
  });

  test("parses an OpenSea asset URL without a chain slug, falling back to default", () => {
    expect(parseTargetInput(`https://opensea.io/assets/${ADDRESS}/1`, "ethereum")).toEqual({ chainKey: "ethereum", contract: ADDRESS });
  });

  test("returns undefined for an OpenSea collection-slug URL (no address in path)", () => {
    expect(parseTargetInput("https://opensea.io/collection/some-cool-drop", "ethereum")).toBeUndefined();
  });

  test("parses a Zora collect URL", () => {
    expect(parseTargetInput(`https://zora.co/collect/base:${ADDRESS}`, "ethereum")).toEqual({ chainKey: "base", contract: ADDRESS });
  });

  test("parses a known block explorer address URL and infers the chain from the host", () => {
    expect(parseTargetInput(`https://basescan.org/address/${ADDRESS}`)).toEqual({ chainKey: "base", contract: ADDRESS });
    expect(parseTargetInput(`https://robinhoodchain.blockscout.com/token/${ADDRESS}`)).toEqual({ chainKey: "robinhood", contract: ADDRESS });
  });

  test("falls back to default chain for an unrecognized host that still has an address in the path", () => {
    expect(parseTargetInput(`https://some-launchpad.xyz/mint/${ADDRESS}`, "ethereum")).toEqual({ chainKey: "ethereum", contract: ADDRESS });
  });

  test("returns undefined for garbage input", () => {
    expect(parseTargetInput("not a url or address", "ethereum")).toBeUndefined();
    expect(parseTargetInput("", "ethereum")).toBeUndefined();
  });
});
