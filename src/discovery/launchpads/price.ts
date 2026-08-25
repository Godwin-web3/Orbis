/** Max native cost we will pay to mint a launchpad cook. Default 0.001 ETH (~a dollar+). */
export function maxLaunchpadPriceWei(): bigint {
  const raw = process.env.MAX_LAUNCHPAD_PRICE_NATIVE ?? "0.001";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 10n ** 15n;
  return BigInt(Math.round(n * 1e18));
}

export function parsePriceToWei(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value < 0n ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    if (value > 1e9) return BigInt(Math.round(value));
    return BigInt(Math.round(value * 1e18));
  }
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/,/g, "");
  if (!v || v === "free") return 0n;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return undefined;
  return BigInt(Math.round(n * 1e18));
}

export function isAffordableMint(priceWei: bigint, cap = maxLaunchpadPriceWei()): boolean {
  return priceWei >= 0n && priceWei <= cap;
}
