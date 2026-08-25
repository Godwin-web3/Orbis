export type ValueInputs = {
  name?: string;
  floorNative?: number;
  volumeAllTimeNative?: number;
  ownerCount?: number;
  tokenCount?: number;
  recentMints?: number;
  twitter?: boolean;
  verified?: boolean;
  openedAgoSeconds?: number;
};

export type ValueScore = {
  estimatedValueNative: number;
  valueScore: number;
  hasSignal: boolean;
  reasons: string[];
};

const SPAM_NAME = /^(untitled|unnamed|test|testing|sample|demo|nft|collection|new collection|my nft|erc721|item)\b/i;

export function isSpamName(name: string | undefined): boolean {
  if (!name || !name.trim()) return true;
  if (SPAM_NAME.test(name.trim())) return true;
  if (/^0x[a-fA-F0-9]{6,}$/.test(name.trim())) return true;
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Turns marketplace + on-chain demand into a conservative resale estimate and a 0–100 score.
 * A brand-new drop with no floor can still score if people are actually minting it.
 * A free mint that has been sitting open with zero demand scores ~0 — that's most of SeaDrop.
 */
export function scoreMintValue(input: ValueInputs): ValueScore {
  const reasons: string[] = [];
  const floor = Math.max(0, input.floorNative ?? 0);
  const volume = Math.max(0, input.volumeAllTimeNative ?? 0);
  const recent = Math.max(0, Math.floor(input.recentMints ?? 0));
  const owners = Math.max(0, input.ownerCount ?? 0);
  const spam = isSpamName(input.name);

  // Illiquid free mints rarely clear the listed floor. Haircut hard.
  const estimatedValueNative = floor > 0 ? floor * 0.4 : 0;

  let score = 0;
  if (floor >= 0.05) { score += 40; reasons.push(`floor ${floor} native`); }
  else if (floor >= 0.01) { score += 28; reasons.push(`floor ${floor} native`); }
  else if (floor >= 0.002) { score += 16; reasons.push(`floor ${floor} native`); }

  if (volume >= 1) { score += 20; reasons.push(`volume ${volume.toFixed(3)}`); }
  else if (volume >= 0.05) { score += 10; reasons.push(`volume ${volume.toFixed(3)}`); }

  if (recent >= 20) { score += 30; reasons.push(`${recent} mints this window`); }
  else if (recent >= 8) { score += 22; reasons.push(`${recent} mints this window`); }
  else if (recent >= 3) { score += 14; reasons.push(`${recent} mints this window`); }
  else if (recent === 0) reasons.push("no recent mints");

  if (owners >= 200) score += 10;
  else if (owners >= 30) score += 5;

  if (input.verified) { score += 12; reasons.push("verified collection"); }
  if (input.twitter) { score += 6; reasons.push("has twitter"); }

  const openedAgo = input.openedAgoSeconds;
  if (openedAgo !== undefined && openedAgo >= 0 && openedAgo <= 2 * 3600) {
    score += 8;
    reasons.push("opened in last 2h");
  }
  if (openedAgo !== undefined && openedAgo > 7 * 86400 && recent === 0 && floor < 0.002) {
    score = Math.min(score, 5);
    reasons.push("open >7d with no demand");
  }

  if (spam) {
    score = Math.floor(score * 0.25);
    reasons.push("generic/spam name");
  }

  score = clamp(Math.round(score), 0, 100);

  const hasSignal = floor >= 0.002 || recent >= 3 || volume >= 0.05 || score >= 20;
  if (!hasSignal) reasons.push("no demand or floor");

  return { estimatedValueNative, valueScore: score, hasSignal, reasons };
}
