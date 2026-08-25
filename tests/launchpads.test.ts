import { describe, expect, test } from "bun:test";
import { parseHoodMintHtml, parseHoodMintPayload, fetchHoodMintDrops } from "../src/discovery/launchpads/hoodmint";
import { encodeHoodseaMint, hoodseaIsLiveMintable, type HoodseaLive } from "../src/discovery/launchpads/hoodsea";
import { isAffordableMint, parsePriceToWei } from "../src/discovery/launchpads/price";

describe("cheap mint cap", () => {
  test("allows Hoodsea platform fee and ~$1 mints, rejects expensive ones", () => {
    expect(isAffordableMint(0n)).toBe(true);
    expect(isAffordableMint(300000000000000n)).toBe(true);
    expect(parsePriceToWei("0.001")).toBe(10n ** 15n);
    expect(isAffordableMint(parsePriceToWei("0.001")!)).toBe(true);
    expect(isAffordableMint(parsePriceToWei("0.05")!)).toBe(false);
  });
});

describe("HoodMint parser", () => {
  test("reads JSON drop lists including cheap paid rows", () => {
    const drops = parseHoodMintPayload({
      drops: [
        { name: "Hooded Pigs", ticker: "PIG", contract: "0x00000000000000000000000000000000000000aa", minted: 1111, supply: 1111, price: "Free", status: "sold out" },
        { name: "SimpHood", ticker: "SIMP", address: "0x00000000000000000000000000000000000000bb", minted: 5, supply: 100, mintPrice: "0.001", status: "open" },
        { name: "No Contract Yet", minted: 5, supply: 100, price: "Free" },
      ],
    });
    expect(drops[1]?.priceWei).toBe(10n ** 15n);
    expect(drops[1]?.free).toBe(false);
  });

  test("parses the public open-drops HTML shape", () => {
    const html = `
      <h3>Diamonds of Robinhood</h3>
      ROBD · 2,222 supply open 66 minted 2,222 Dev Mint Free
      0x00000000000000000000000000000000000000cc
      <h3>Hooded Pigs</h3>
      PIG · 1,111 supply sold out 1,111 minted 1,111 Public Mint Free
    `;
    const drops = parseHoodMintHtml(html);
    expect(drops.some((drop) => drop.name.includes("Diamonds") && drop.free && drop.contract)).toBe(true);
  });

  test("fetch ignores dead endpoints and returns [] instead of throwing", async () => {
    const fetchImpl = (async () => ({ ok: false, headers: { get: () => "" } })) as unknown as typeof fetch;
    expect(await fetchHoodMintDrops({ urls: ["https://hoodmint.online/drops/open"], fetchImpl })).toEqual([]);
  });
});

describe("Hoodsea live mintable gate", () => {
  const base: HoodseaLive = {
    collection: "0x00000000000000000000000000000000000000dd",
    name: "Pigs",
    mintPrice: 0n,
    platformFee: 0n,
    minted: 12,
    remaining: 100,
    startTime: 1,
    endTime: 0,
    bonded: false,
    open: true,
  };

  test("allows zero and cheap platform fees, blocks sold-out and expensive", () => {
    expect(hoodseaIsLiveMintable(base)).toBe(true);
    expect(hoodseaIsLiveMintable({ ...base, platformFee: 300000000000000n })).toBe(true);
    expect(hoodseaIsLiveMintable({ ...base, mintPrice: 10n ** 15n })).toBe(true);
    expect(hoodseaIsLiveMintable({ ...base, mintPrice: 5n * 10n ** 16n })).toBe(false);
    expect(hoodseaIsLiveMintable({ ...base, bonded: true })).toBe(false);
    expect(hoodseaIsLiveMintable({ ...base, remaining: 0 })).toBe(false);
  });

  test("encodes mint(quantity, empty proof) for the public phase", () => {
    const data = encodeHoodseaMint(1n);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});
