import AdmZip from "adm-zip";

/**
 * Size-based pricing. We inspect the uploaded .zip, count the "real" Solidity
 * source files (excluding tests/scripts/libs/build output) and their total
 * bytes, then pick a tier by whichever metric is larger. The resulting price is
 * what the 402 payment gate charges for this job (in native MNT).
 */

export type Tier = "small" | "medium" | "large";

export interface ProjectSizing {
  solFiles: number;
  totalBytes: number;
  tier: Tier;
  /** Price in native MNT (human units). */
  priceMnt: number;
  /** Price in wei (18 decimals) — the amount the payer must send to payTo. */
  amountWei: string;
}

// Path segments that mark non-source code we should not price on.
const EXCLUDED_SEGMENTS = new Set([
  "test", "tests", "script", "scripts", "lib", "node_modules",
  "out", "cache", "broadcast", "__macosx",
]);

function isPricedSolidity(entryName: string): boolean {
  const path = entryName.replace(/\\/g, "/");
  if (!path.toLowerCase().endsWith(".sol")) return false;
  const segments = path.toLowerCase().split("/");
  const file = segments[segments.length - 1];
  // Foundry test/script convention.
  if (file.endsWith(".t.sol") || file.endsWith(".s.sol")) return false;
  if (segments.slice(0, -1).some((s) => EXCLUDED_SEGMENTS.has(s))) return false;
  return true;
}

// Base price per tier in native MNT (testnet) — this is the Level 1 (Standard)
// price. Tweak here.
const PRICE_BY_TIER: Record<Tier, number> = {
  small: 1,
  medium: 5,
  large: 10,
};

// Level 2 (Aggressive) does deeper work (storage redesign + forge verification
// loop), so it costs more: the base tier price × this multiplier.
const LEVEL2_PRICE_MULTIPLIER = 3;

/** Convert a MNT amount (≤3 decimals) to wei without float error. */
function mntToWei(mnt: number): string {
  return (BigInt(Math.round(mnt * 1000)) * 10n ** 15n).toString();
}

function pickTier(solFiles: number, totalBytes: number): Tier {
  const KB = 1024;
  // Both metrics must fit a tier; otherwise bump up (so either one over the
  // limit promotes the project to the next tier).
  if (solFiles <= 3 && totalBytes <= 30 * KB) return "small";
  if (solFiles <= 20 && totalBytes <= 200 * KB) return "medium";
  return "large";
}

/**
 * Inspect a .zip on disk and compute its tier + price. The price is the tier's
 * base (Level 1 / Standard) price, multiplied for Level 2 (Aggressive).
 */
export function priceZip(zipPath: string, level: 1 | 2 = 1): ProjectSizing {
  const zip = new AdmZip(zipPath);
  let solFiles = 0;
  let totalBytes = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!isPricedSolidity(entry.entryName)) continue;
    solFiles++;
    totalBytes += entry.header.size; // uncompressed size
  }

  const tier = pickTier(solFiles, totalBytes);
  const priceMnt = PRICE_BY_TIER[tier] * (level === 2 ? LEVEL2_PRICE_MULTIPLIER : 1);
  return { solFiles, totalBytes, tier, priceMnt, amountWei: mntToWei(priceMnt) };
}
