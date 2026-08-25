import { describe, expect, test } from "bun:test";
import { parseHoodMintHtml, parseHoodMintPayload, fetchHoodMintDrops } from "../src/discovery/launchpads/hoodmint";
import { encodeHoodseaMint, hoodseaIsLiveFree, type HoodseaLive } from "../src/discovery/launchpads/hoodsea";

describe("HoodMint parser", () => {
  test("reads JSON drop lists and keeps only rows with a contract", () => {
    const drops = parseHoodMintPayload({
      drops: [
        { name: "Hooded Pigs", ticker: "PIG", contract: "0x00000000000000000000000000000000000000aa", minted: 1111, supply: 1111, price: "Free", status: "sold out" },
        { name: "Diamonds of Robinhood", ticker: "ROBD", address: "0x00000000000000000000000000000000000000bb", minted: 66, supply: 2222, mintPrice: 0, status: "open" },
        { name: "No Contract Yet", minted: 5, supply: 100, price: "Free" },
      ],
    });
    expect(drops).toHaveLength(3);
    expect(drops[1]?.contract).toBe("0x00000000000000000000000000000000000000bb");
    expect(drops[1]?.free).toBe(true);
    expect(drops[2]?.contract).toBeUndefined();
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

describe("Hoodsea live-free gate", () => {
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

  test("passes only zero-price unbonded open collections", () => {
    expect(hoodseaIsLiveFree(base)).toBe(true);
    expect(hoodseaIsLiveFree({ ...base, mintPrice: 1n })).toBe(false);
    expect(hoodseaIsLiveFree({ ...base, platformFee: 300000000000000n })).toBe(false);
    expect(hoodseaIsLiveFree({ ...base, bonded: true })).toBe(false);
    expect(hoodseaIsLiveFree({ ...base, remaining: 0 })).toBe(false);
  });

  test("encodes mint(quantity, empty proof) for the public phase", () => {
    const data = encodeHoodseaMint(1n);
    expect(data.startsWith("0x")).toBe(true);
    expect(data.length).toBeGreaterThan(10);
  });
});
