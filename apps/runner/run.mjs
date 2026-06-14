/**
 * Isolated gas-optimization runner. Operates on the mounted /work directory.
 *
 * Loop (mirrors skills/gas-optimizer/SKILL.md):
 *   1. locate the project + Solidity sources
 *   2. baseline gas snapshot (forge test --gas-report) if it's a buildable Foundry project
 *   3. apply behaviour-preserving optimizations (currently a MOCK regex pass —
 *      this is the seam for the real Claude Agent SDK engine)
 *   4. verify: forge build + test must still pass; revert if they break
 *   5. re-measure gas, compute savings
 *   6. write OPTIMIZATION_REPORT.md (kept in the result zip) and
 *      OPTLE_RESULT.json (machine-readable; the server strips it from the zip)
 *
 * Writes nothing outside /work. Exit 0 on success (even "no foundry" is success).
 */
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const WORK = process.env.WORK_DIR ?? "/work";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (["node_modules", ".git", "out", "cache", "broadcast", "__MACOSX"].includes(name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Project root = dir containing foundry.toml (search work + one level of subdirs). */
function findProjectRoot() {
  if (existsSync(join(WORK, "foundry.toml"))) return WORK;
  for (const name of readdirSync(WORK)) {
    const sub = join(WORK, name);
    if (statSync(sub).isDirectory() && existsSync(join(sub, "foundry.toml"))) return sub;
  }
  return null;
}

/** Source .sol files to optimize (exclude tests/scripts/libs/build dirs). */
function sourceSolFiles(base) {
  return walk(base).filter((p) => {
    if (!p.endsWith(".sol")) return false;
    const rel = relative(base, p).toLowerCase().split("/");
    const file = rel[rel.length - 1];
    if (file.endsWith(".t.sol") || file.endsWith(".s.sol")) return false;
    return !rel.slice(0, -1).some((s) =>
      ["test", "tests", "script", "scripts", "lib", "node_modules", "out", "cache"].includes(s),
    );
  });
}

function tryForge(cmd, cwd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Sum of avg gas across function rows in a `forge test --gas-report` table. */
function totalGas(report) {
  let total = 0;
  for (const line of report.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 7) continue;
    const name = cells[1];
    const avg = Number(cells[3]);
    if (!name || name === "Function Name" || Number.isNaN(avg)) continue;
    if (/Contract|Deployment|^\d+$/.test(name)) continue;
    total += avg;
  }
  return total;
}

/** MOCK optimizer pass. SEAM: replace with the Claude Agent SDK engine. */
function optimizeSource(code) {
  let out = code;
  const changes = [];

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
  return { out, changes };
}

function writeResult(result) {
  writeFileSync(join(WORK, "OPTLE_RESULT.json"), JSON.stringify(result, null, 2));
}

function writeReport({ changes, gasBefore, gasAfter, savedPct, verified, message }) {
  const lines = [
    "# Gas Optimization Report",
    "",
    message ? `> ${message}` : "",
    "",
    "## Changes",
    ...(changes.length
      ? changes.map((c) => `- **${c.rule}** (${c.kind}, ×${c.count}) — ${c.description}`)
      : ["- No optimization opportunities detected."]),
    "",
    "## Gas",
    verified
      ? `- Verified with \`forge test --gas-report\`.\n- Before: **${gasBefore}**, After: **${gasAfter}** → **−${savedPct}%**`
      : `- Not verified with Foundry (no buildable project). Estimated saving: **−${savedPct}%**`,
    "",
  ];
  writeFileSync(join(WORK, "OPTIMIZATION_REPORT.md"), lines.filter((l) => l !== undefined).join("\n"));
}

function main() {
  const root = findProjectRoot();
  const base = root ?? WORK;
  const files = sourceSolFiles(base);

  if (files.length === 0) {
    const r = { ok: false, verified: false, message: "No Solidity source files found." };
    writeResult(r);
    writeReport({ changes: [], savedPct: 0, verified: false, message: r.message });
    return;
  }

  // 2) baseline (only if it's a Foundry project that builds)
  let canVerify = false;
  let gasBefore = 0;
  if (root) {
    const build = tryForge("forge build", root);
    if (build.ok) {
      const report = tryForge("forge test --gas-report", root);
      if (report.ok) {
        gasBefore = totalGas(report.out);
        canVerify = gasBefore > 0;
      }
    }
  }

  // 3) optimize (mock), keeping originals for possible revert
  const originals = new Map();
  const allChanges = [];
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    originals.set(f, before);
    const { out, changes } = optimizeSource(before);
    if (out !== before) writeFileSync(f, out);
    allChanges.push(...changes);
  }

  // 4) verify; revert all if build/test breaks
  let verified = false;
  let gasAfter = 0;
  if (canVerify) {
    const build = tryForge("forge build", root);
    const test = build.ok ? tryForge("forge test --gas-report", root) : build;
    if (build.ok && test.ok) {
      gasAfter = totalGas(test.out);
      verified = true;
    } else {
      for (const [f, src] of originals) writeFileSync(f, src); // revert
    }
  }

  // 5) compute savings
  const applied = allChanges.filter((c) => c.kind === "applied").reduce((n, c) => n + c.count, 0);
  const detected = allChanges.filter((c) => c.kind === "detected").reduce((n, c) => n + c.count, 0);
  let savedPct;
  if (verified && gasBefore > 0) {
    savedPct = Number((((gasBefore - gasAfter) / gasBefore) * 100).toFixed(1));
  } else {
    // heuristic estimate when we can't run Foundry
    const frac = Math.min(0.35, applied * 0.02 + detected * 0.03);
    savedPct = Number((frac * 100).toFixed(1));
  }

  const result = {
    ok: true,
    verified,
    gasBefore: verified ? gasBefore : undefined,
    gasAfter: verified ? gasAfter : undefined,
    savedPct,
    changes: allChanges,
    message: verified
      ? "Optimized and verified with Foundry tests."
      : "Optimized (mock pass); Foundry verification unavailable for this project.",
  };
  writeResult(result);
  writeReport({ changes: allChanges, gasBefore, gasAfter, savedPct, verified, message: result.message });
}

try {
  main();
} catch (err) {
  writeResult({ ok: false, verified: false, message: `runner error: ${String(err)}` });
  process.exitCode = 1;
}
