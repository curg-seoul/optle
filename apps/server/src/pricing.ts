import AdmZip from "adm-zip";

/**
 * Size-based pricing. We inspect the uploaded .zip, count the "real" Solidity
 * source files (excluding tests/scripts/libs/build output) and their total
 * bytes, then pick a tier by whichever metric is larger. The resulting price is
 * what the x402 gate charges for this job.
 */

export type Tier = "small" | "medium" | "large";

export interface ProjectSizing {
  solFiles: number;
  totalBytes: number;
  tier: Tier;
  priceUsd: number;
  /** USDC base units (6 decimals) for the x402 challenge. */
  amountBaseUnits: string;
}

const USDC_DECIMALS = 6;

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

const PRICE_BY_TIER: Record<Tier, number> = {
  small: 0.5,
  medium: 3,
  large: 10,
};

function pickTier(solFiles: number, totalBytes: number): Tier {
  const KB = 1024;
  // Both metrics must fit a tier; otherwise bump up (so either one over the
  // limit promotes the project to the next tier).
  if (solFiles <= 3 && totalBytes <= 30 * KB) return "small";
  if (solFiles <= 20 && totalBytes <= 200 * KB) return "medium";
  return "large";
}

/** Inspect a .zip on disk and compute its tier + price. */
export function priceZip(zipPath: string): ProjectSizing {
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
  const priceUsd = PRICE_BY_TIER[tier];
  const amountBaseUnits = Math.round(priceUsd * 10 ** USDC_DECIMALS).toString();
  return { solFiles, totalBytes, tier, priceUsd, amountBaseUnits };
}
