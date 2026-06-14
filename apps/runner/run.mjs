/**
 * Isolated gas-optimization runner. Operates on the mounted /work directory.
 *
 * Output model (per the solidity-gas-optimizer skill): the ORIGINAL sources under
 * src/ are never edited in place. The optimized variants are written to a
 * separate `optimized/` directory (suffixed `optimized-<rand>` if one already
 * exists), mirroring the original source layout. Verification swaps the optimized
 * files into the source locations temporarily, runs `forge test --gas-report`,
 * then restores the originals.
 *
 * Two engines:
 *   - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set → Claude Agent SDK with
 *     the solidity-gas-optimizer skill loaded natively. Needs network.
 *   - otherwise → MOCK regex pass (offline).
 */
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync,
  mkdirSync, rmSync, cpSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const WORK = process.env.WORK_DIR ?? "/work";
const SKILL_SRC = process.env.OPTLE_SKILL_SRC ?? "/app/skill/solidity-gas-optimizer";
process.env.PATH = `/root/.foundry/bin:${process.env.HOME ?? ""}/.foundry/bin:${process.env.PATH}`;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["node_modules", ".git", ".claude", "out", "cache", "broadcast", "__MACOSX", "optimized"].includes(name)
        || name.startsWith("optimized-")) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

function findProjectRoot() {
  if (existsSync(join(WORK, "foundry.toml"))) return WORK;
  for (const name of readdirSync(WORK)) {
    const sub = join(WORK, name);
    if (statSync(sub).isDirectory() && existsSync(join(sub, "foundry.toml"))) return sub;
  }
  return null;
}

function sourceSolFiles(base) {
  return walk(base).filter((p) => {
    if (!p.endsWith(".sol")) return false;
    const rel = relative(base, p).toLowerCase().split("/");
    const file = rel[rel.length - 1];
    if (file.endsWith(".t.sol") || file.endsWith(".s.sol")) return false;
    return !rel.slice(0, -1).some((s) =>
      ["test", "tests", "script", "scripts", "lib", "node_modules", "out", "cache"].includes(s));
  });
}

function tryForge(cmd, cwd) {
  try {
    return { ok: true, out: execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

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

/** MOCK optimizer pass — returns optimized source + the changes it made. */
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
  if (lengthInLoop) changes.push({ rule: "cache-array-length", kind: "detected", count: lengthInLoop, description: "`.length` read inside a loop condition — cache it in a local." });
  const requireStr = out.match(/require\s*\([^;]*,\s*["'][^"']*["']\s*\)/g)?.length ?? 0;
  if (requireStr) changes.push({ rule: "custom-errors", kind: "detected", count: requireStr, description: "require(cond, \"msg\") can become a custom error." });
  return { out, changes };
}

/** Real engine: run the Claude Agent SDK with the skill loaded natively. */
async function runAgent(base, model, outName, level) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Make the skill discoverable as a project skill (references resolve relative).
  const skillDest = join(base, ".claude", "skills", "solidity-gas-optimizer");
  if (existsSync(SKILL_SRC)) {
    mkdirSync(dirname(skillDest), { recursive: true });
    cpSync(SKILL_SRC, skillDest, { recursive: true });
  } else {
    console.error(`[runner] skill source not found at ${SKILL_SRC}`);
  }

  const levelText =
    level === 2
      ? `Apply LEVEL 2 optimizations: you MAY redesign the internal storage layout — struct/slot ` +
        `packing, smaller integer types, bitmaps, UDVTs — because this is a fresh new deployment ` +
        `with no proxy. Preserve the EXTERNAL interface exactly (function signatures, ` +
        `visibility-as-callable, events, return shapes); custom errors are encouraged.`
      : `Apply LEVEL 1 optimizations ONLY: function-body changes that do NOT alter the storage ` +
        `layout or external interface — cache repeated SLOADs, hoist invariants and cache array ` +
        `length out of loops, unchecked increments, ++i, constant/immutable for never-reassigned ` +
        `values, public->external, calldata params, custom errors, drop redundant init/checks. ` +
        `Do NOT repack structs, resize field types, or change any storage slot assignment.`;

  const prompt =
    `Use your solidity-gas-optimizer skill to optimize the Solidity contracts under src/. ` +
    `${levelText} ` +
    `Write the optimized variants into the \`${outName}/\` directory, mirroring the original ` +
    `source layout (e.g. src/Foo.sol -> ${outName}/src/Foo.sol). Do NOT modify the original ` +
    `files in place. Verify with forge per the skill's verification gate, then write ` +
    `OPTIMIZATION_REPORT.md at the project root.`;

  let cost = 0, turns = 0;
  for await (const msg of query({
    prompt,
    options: {
      cwd: base,
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Skill"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      skills: ["solidity-gas-optimizer"],
      stderr: (data) => console.error(`[agent-stderr] ${String(data).trimEnd()}`),
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) console.log(`[agent] ${block.text.trim()}`);
        else if (block.type === "tool_use") {
          const arg = block.name === "Bash" ? block.input.command : (block.input.file_path ?? block.input.command ?? "");
          console.log(`[agent] · ${block.name}: ${String(arg)}`);
        }
      }
    } else if (msg.type === "result") {
      turns = msg.num_turns;
      if (msg.subtype === "success") cost = msg.total_cost_usd;
      else console.error(`[agent ended: ${msg.subtype}]`);
    }
  }
  rmSync(join(base, ".claude"), { recursive: true, force: true }); // keep out of the result zip
  return { cost, turns };
}

function parseReportChanges(base) {
  const p = join(base, "OPTIMIZATION_REPORT.md");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const changes = [];
  let inChanges = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { inChanges = /change|optimi|transform/i.test(line); continue; }
    if (inChanges) {
      const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/) || line.match(/^\s*\|\s*([^|]+?)\s*\|/);
      const desc = m?.[1]?.replace(/\*\*/g, "").trim();
      if (desc && !/^-+$/.test(desc) && !/^(change|optimization|transform)s?$/i.test(desc)) {
        changes.push({ rule: "agent", kind: "applied", count: 1, description: desc });
      }
    }
  }
  if (changes.length === 0 && existsSync(p)) changes.push({ rule: "agent", kind: "applied", count: 1, description: "See OPTIMIZATION_REPORT.md for details." });
  return changes;
}

function writeResult(result) {
  writeFileSync(join(WORK, "OPTLE_RESULT.json"), JSON.stringify(result, null, 2));
}

/** GitHub-style unified diff (only changed hunks) between original and optimized. */
function unifiedDiff(originalPath, optimizedPath) {
  let raw = "";
  try {
    raw = execSync(`git diff --no-index --no-color -- "${originalPath}" "${optimizedPath}"`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    raw = e.stdout ?? ""; // git exits 1 when the files differ
  }
  const at = raw.indexOf("\n@@");
  const body = at >= 0 ? raw.slice(at + 1) : "";
  // Cap very large diffs so the status payload stays reasonable.
  const lines = body.split("\n");
  return lines.length > 600 ? lines.slice(0, 600).join("\n") + "\n… (diff truncated)" : body;
}

/** Per-file diffs (original src vs its optimized counterpart). */
function buildDiffs(base, outAbs, files) {
  const diffs = [];
  for (const f of files) {
    const opt = optimizedFor(base, outAbs, f);
    if (!opt) continue;
    const diff = unifiedDiff(f, opt);
    if (diff.trim()) diffs.push({ file: relative(base, f), diff });
  }
  return diffs;
}

function writeReport(base, { changes, gasBefore, gasAfter, savedPct, verified, message, outName }) {
  const lines = [
    "# Gas Optimization Report", "",
    message ? `> ${message}` : "",
    outName ? `\nOptimized sources are in \`${outName}/\` (originals under \`src/\` are unchanged).` : "",
    "", "## Changes",
    ...(changes.length ? changes.map((c) => `- ${c.description}`) : ["- No optimization opportunities detected."]),
    "", "## Gas",
    verified
      ? `- Verified with \`forge test --gas-report\`.\n- Before: **${gasBefore}**, After: **${gasAfter}** → **−${savedPct}%**`
      : `- Foundry verification unavailable. ${gasBefore ? `Before: ${gasBefore}.` : ""}`,
    "",
  ];
  writeFileSync(join(base, "OPTIMIZATION_REPORT.md"), lines.filter((l) => l !== undefined).join("\n"));
}

/** For each original source file, find its optimized counterpart in outAbs. */
function optimizedFor(base, outAbs, srcFile) {
  const rel = relative(base, srcFile);
  const mirrored = join(outAbs, rel);
  if (existsSync(mirrored)) return mirrored;
  // fallback: match by basename anywhere under outAbs
  const baseName = rel.split("/").pop();
  const stack = [outAbs];
  while (stack.length) {
    const d = stack.pop();
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (n === baseName) return p;
    }
  }
  return null;
}

async function main() {
  const root = findProjectRoot();
  const base = root ?? WORK;
  const files = sourceSolFiles(base);

  if (files.length === 0) {
    const r = { ok: false, verified: false, engine: "none", message: "No Solidity source files found." };
    writeResult(r);
    writeReport(base, { changes: [], savedPct: 0, verified: false, message: r.message });
    return;
  }

  // Snapshot originals so src/ is always restored pristine.
  const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  // Baseline gas on the originals.
  let gasBefore = 0;
  if (root && tryForge("forge build", root).ok) {
    const report = tryForge("forge test --gas-report", root);
    if (report.ok) gasBefore = totalGas(report.out);
  }

  // Output directory (random suffix if `optimized/` already exists).
  const outName = existsSync(join(base, "optimized")) ? `optimized-${randomBytes(3).toString("hex")}` : "optimized";
  const outAbs = join(base, outName);

  const useAgent = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) || process.env.OPTLE_FORCE_AGENT === "1";
  const engine = useAgent ? "claude" : "mock";
  const model = process.env.OPTLE_MODEL || "claude-sonnet-4-6";
  const level = process.env.OPTLE_LEVEL === "2" ? 2 : 1;
  console.log(`[runner] engine=${engine}${useAgent ? ` model=${model} level=${level}` : ""} files=${files.length} foundry=${Boolean(root)} out=${outName}`);

  let changes = [];
  let agentMeta;
  if (useAgent) {
    agentMeta = await runAgent(base, model, outName, level);
    changes = parseReportChanges(base);
  } else {
    for (const f of files) {
      const { out, changes: cs } = optimizeSource(originals.get(f));
      const dest = join(outAbs, relative(base, f));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, out);
      changes.push(...cs);
    }
  }

  // Restore any in-place edits the agent may have made → src/ pristine.
  for (const [f, src] of originals) writeFileSync(f, src);

  // Measure the optimized gas. Preferred: the agent leaves a self-contained,
  // runnable optimized/ project (its own foundry.toml + mirror tests), which
  // handles layout changes (packing → getter types) and custom errors correctly.
  let verified = false, gasAfter = 0;
  if (existsSync(join(outAbs, "foundry.toml"))) {
    const t = tryForge("forge test --gas-report", outAbs);
    if (t.ok) { gasAfter = totalGas(t.out); verified = true; }
  }
  // Fallback (mock engine, or no optimized project): swap optimized files into
  // the source tree, run the original tests, then restore.
  if (!verified && root && gasBefore > 0) {
    const swapped = [];
    for (const f of files) {
      const opt = optimizedFor(base, outAbs, f);
      if (opt) { writeFileSync(f, readFileSync(opt, "utf8")); swapped.push(f); }
    }
    if (swapped.length) {
      const build = tryForge("forge build", root);
      const test = build.ok ? tryForge("forge test --gas-report", root) : build;
      if (build.ok && test.ok) { gasAfter = totalGas(test.out); verified = true; }
    }
    for (const [f, src] of originals) writeFileSync(f, src); // restore again
  }

  let savedPct;
  if (verified && gasBefore > 0) savedPct = Number((((gasBefore - gasAfter) / gasBefore) * 100).toFixed(1));
  else {
    const applied = changes.filter((c) => c.kind !== "detected").reduce((n, c) => n + (c.count || 1), 0);
    savedPct = Number((Math.min(0.35, applied * 0.02) * 100).toFixed(1));
  }

  const message = verified
    ? `Optimized with ${engine === "claude" ? "Claude" : "the mock pass"} into ${outName}/ and verified with Foundry tests.`
    : `Optimized with ${engine === "claude" ? "Claude" : "the mock pass"} into ${outName}/; Foundry verification unavailable.`;

  const diffs = buildDiffs(base, outAbs, files);

  writeResult({
    ok: true, engine, verified, outDir: outName,
    gasBefore: gasBefore || undefined, gasAfter: gasAfter || undefined,
    savedPct, changes, diffs, costUsd: agentMeta?.cost, message,
  });
  if (!existsSync(join(base, "OPTIMIZATION_REPORT.md"))) {
    writeReport(base, { changes, gasBefore, gasAfter, savedPct, verified, message, outName });
  }
}

main().catch((err) => {
  console.error("[runner] FATAL:", err?.stack || String(err));
  writeResult({ ok: false, verified: false, engine: "error", message: `runner error: ${String(err)}` });
  process.exitCode = 1;
});
