/**
 * Optimization entry point for the server.
 *
 * ⚠️ DEV: this is a MOCK — it does NOT call any AI API (cost = 0).
 *
 * DEPLOY SEAM: when we decide to go live, replace the body of `optimize()` with
 * a Claude Agent SDK call (write the contract to a temp Foundry project, run the
 * gas-optimizer skill + `forge`, read back the result). The input/output shape
 * below is what the real implementation must also return, so callers don't change.
 *
 * Mirrors apps/web/src/mockOptimizer.ts.
 */

export interface Change {
  rule: string;
  kind: "applied" | "detected";
  description: string;
  count: number;
}

export interface OptimizeResult {
  mock: boolean;
  original: string;
  optimized: string;
  changes: Change[];
  gasBefore: number;
  gasAfter: number;
  savedPct: number;
}

export function optimize(code: string): OptimizeResult {
  let out = code;
  const changes: Change[] = [];

  const postInc = out.match(/\b([A-Za-z_]\w*)\+\+/g)?.length ?? 0;
  if (postInc) {
    out = out.replace(/\b([A-Za-z_]\w*)\+\+/g, "++$1");
    changes.push({ rule: "pre-increment", kind: "applied", count: postInc, description: "i++ → ++i — pre-increment avoids a temporary copy." });
  }

  const zeroInit = out.match(/\b(u?int\d*)\s+(\w+)\s*=\s*0\s*;/g)?.length ?? 0;
  if (zeroInit) {
    out = out.replace(/\b(u?int\d*)\s+(\w+)\s*=\s*0\s*;/g, "$1 $2;");
    changes.push({ rule: "drop-zero-init", kind: "applied", count: zeroInit, description: "uint x = 0; → uint x; — default value is already zero." });
  }

  const lengthInLoop = out.match(/for\s*\([^;]*;[^;]*\.length[^;]*;/g)?.length ?? 0;
  if (lengthInLoop) {
    changes.push({ rule: "cache-array-length", kind: "detected", count: lengthInLoop, description: "`.length` read inside a loop condition — cache it in a local." });
  }

  const requireStr = out.match(/require\s*\([^;]*,\s*["'][^"']*["']\s*\)/g)?.length ?? 0;
  if (requireStr) {
    changes.push({ rule: "custom-errors", kind: "detected", count: requireStr, description: "require(cond, \"msg\") can become a custom error — saves deploy + revert gas." });
  }

  const publicFns = out.match(/function\s+\w+\s*\([^)]*\)\s*public\b/g)?.length ?? 0;
  if (publicFns) {
    changes.push({ rule: "external-visibility", kind: "detected", count: publicFns, description: "`public` functions never called internally can be `external`." });
  }

  const savedFraction = Math.min(
    0.35,
    ((postInc ? 1 : 0) + (zeroInit ? 1 : 0)) * 0.02 + (lengthInLoop * 1.5 + requireStr + publicFns * 0.5) * 0.03,
  );
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
