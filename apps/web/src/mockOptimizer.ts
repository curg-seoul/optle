/**
 * MOCK gas optimizer — stands in for the real AI agent during development.
 * No AI/API calls. Deterministic regex transforms + heuristic gas estimate.
 *
 * Two kinds of findings:
 *   - applied:  a safe transform we actually performed (shows in the diff)
 *   - detected: an opportunity we flagged but did not auto-apply
 *
 * When the real agent is wired in (post-deploy), this module is the seam it
 * replaces: same input (Solidity source) → same OptimizeResult shape.
 */

export interface Change {
  rule: string;
  kind: "applied" | "detected";
  description: string;
  count: number;
}

export interface OptimizeResult {
  mock: true;
  original: string;
  optimized: string;
  changes: Change[];
  gasBefore: number;
  gasAfter: number;
  savedPct: number;
}

export function mockOptimize(code: string): OptimizeResult {
  let out = code;
  const changes: Change[] = [];

  // --- applied transforms (safe, visible in the diff) ---

  // pre-increment: i++ → ++i  (avoids a temporary copy)
  const postInc = out.match(/\b([A-Za-z_]\w*)\+\+/g)?.length ?? 0;
  if (postInc) {
    out = out.replace(/\b([A-Za-z_]\w*)\+\+/g, "++$1");
    changes.push({
      rule: "pre-increment",
      kind: "applied",
      description: "i++ → ++i — pre-increment avoids a temporary copy.",
      count: postInc,
    });
  }

  // drop redundant zero-initialization: uint x = 0; → uint x;
  const zeroInit = out.match(/\b(u?int\d*)\s+(\w+)\s*=\s*0\s*;/g)?.length ?? 0;
  if (zeroInit) {
    out = out.replace(/\b(u?int\d*)\s+(\w+)\s*=\s*0\s*;/g, "$1 $2;");
    changes.push({
      rule: "drop-zero-init",
      kind: "applied",
      description: "uint x = 0; → uint x; — the default value is already zero.",
      count: zeroInit,
    });
  }

  // --- detected opportunities (flagged, not auto-applied) ---

  const lengthInLoop = out.match(/for\s*\([^;]*;[^;]*\.length[^;]*;/g)?.length ?? 0;
  if (lengthInLoop) {
    changes.push({
      rule: "cache-array-length",
      kind: "detected",
      description: "`.length` read inside a loop condition — cache it in a local (one SLOAD instead of one per iteration).",
      count: lengthInLoop,
    });
  }

  const requireStr = out.match(/require\s*\([^;]*,\s*["'][^"']*["']\s*\)/g)?.length ?? 0;
  if (requireStr) {
    changes.push({
      rule: "custom-errors",
      kind: "detected",
      description: "require(cond, \"message\") can become a custom error — saves deployment size and revert gas.",
      count: requireStr,
    });
  }

  const publicFns = out.match(/function\s+\w+\s*\([^)]*\)\s*public\b/g)?.length ?? 0;
  if (publicFns) {
    changes.push({
      rule: "external-visibility",
      kind: "detected",
      description: "`public` functions never called internally can be `external` (cheaper argument handling).",
      count: publicFns,
    });
  }

  // --- mock gas estimate (NOT a real measurement) ---
  const appliedWeight = (postInc ? 1 : 0) + (zeroInit ? 1 : 0);
  const detectedWeight = lengthInLoop * 1.5 + requireStr + publicFns * 0.5;
  const savedFraction = Math.min(0.35, appliedWeight * 0.02 + detectedWeight * 0.03);

  // seed the "before" number off the source size so it feels code-specific
  const gasBefore = 40_000 + Math.round(code.length * 9.5);
  const gasAfter = Math.round(gasBefore * (1 - savedFraction));

  return {
    mock: true,
    original: code,
    optimized: out,
    changes,
    gasBefore,
    gasAfter,
    savedPct: Number((savedFraction * 100).toFixed(1)),
  };
}
