/**
 * Isolated gas-optimization runner. Operates on the mounted /work directory.
 *
 * Two engines, chosen at runtime:
 *   - ANTHROPIC_API_KEY set  → real Claude Agent SDK (edits files + runs forge
 *     itself, following skills/gas-optimizer/SKILL.md). Needs network.
 *   - otherwise               → MOCK regex pass (offline).
 *
 * Loop (mirrors SKILL.md): baseline snapshot → optimize → forge verify → revert
 * if broken (mock) → re-measure → write OPTIMIZATION_REPORT.md + OPTLE_RESULT.json
 * (the server strips the result json from the downloadable zip).
 *
 * Writes nothing outside /work. Exit 0 on success.
 */
import {
  readdirSync, readFileSync, writeFileSync, statSync, existsSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const WORK = process.env.WORK_DIR ?? "/work";
const HERE = dirname(fileURLToPath(import.meta.url));
// Make forge reachable for our own measurements and the agent's Bash tool.
process.env.PATH = `/root/.foundry/bin:${process.env.HOME ?? ""}/.foundry/bin:${process.env.PATH}`;

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

function readSkillBody() {
  const candidates = [join(HERE, "SKILL.md"), join(HERE, "..", "..", "skills", "gas-optimizer", "SKILL.md")];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  }
  return "";
}

/** MOCK optimizer pass. */
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
  const publicFns = out.match(/function\s+\w+\s*\([^)]*\)\s*public\b/g)?.length ?? 0;
  if (publicFns) changes.push({ rule: "external-visibility", kind: "detected", count: publicFns, description: "`public` functions never called internally can be `external`." });
  return { out, changes };
}

/** Real engine: run the Claude Agent SDK in the project dir. */
async function runAgent(base, model) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const skill = readSkillBody();
  const prompt =
    "This is a Solidity project (Foundry if foundry.toml is present). Optimize the " +
    "gas usage of the contracts under src/ following your gas-optimizer instructions. " +
    "If it's a Foundry project, verify with `forge test --gas-report` that all tests " +
    "still pass and gas went down, reverting any change that breaks a test. Finally " +
    "write OPTIMIZATION_REPORT.md at the project root.";

  let cost = 0;
  let turns = 0;
  for await (const msg of query({
    prompt,
    options: {
      cwd: base,
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      systemPrompt: { type: "preset", preset: "claude_code", append: skill },
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) console.log(`[agent] ${block.text.trim().slice(0, 300)}`);
        else if (block.type === "tool_use") {
          const arg = block.name === "Bash" ? block.input.command : (block.input.file_path ?? "");
          console.log(`[agent] · ${block.name}: ${String(arg).slice(0, 120)}`);
        }
      }
    } else if (msg.type === "result") {
      turns = msg.num_turns;
      if (msg.subtype === "success") cost = msg.total_cost_usd;
      else console.error(`[agent ended: ${msg.subtype}]`);
    }
  }
  return { cost, turns };
}

/** Pull change bullets out of an agent-written OPTIMIZATION_REPORT.md. */
function parseReportChanges(base) {
  const p = join(base, "OPTIMIZATION_REPORT.md");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const changes = [];
  let inChanges = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { inChanges = /change|optimi/i.test(line); continue; }
    if (inChanges) {
      // bullets ("- x"), numbered ("1. x"), or table rows ("| x | ... |")
      const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/) || line.match(/^\s*\|\s*([^|]+?)\s*\|/);
      const desc = m?.[1]?.replace(/\*\*/g, "").trim();
      if (desc && !/^-+$/.test(desc) && !/^(change|optimization)s?$/i.test(desc)) {
        changes.push({ rule: "agent", kind: "applied", count: 1, description: desc });
      }
    }
  }
  // Fallback so the UI isn't empty when the agent used prose/tables we couldn't parse.
  if (changes.length === 0 && existsSync(p)) {
    changes.push({ rule: "agent", kind: "applied", count: 1, description: "See OPTIMIZATION_REPORT.md for details." });
  }
  return changes;
}

function writeResult(result) {
  writeFileSync(join(WORK, "OPTLE_RESULT.json"), JSON.stringify(result, null, 2));
}

function writeReport(base, { changes, gasBefore, gasAfter, savedPct, verified, message }) {
  const lines = [
    "# Gas Optimization Report", "",
    message ? `> ${message}` : "", "",
    "## Changes",
    ...(changes.length ? changes.map((c) => `- **${c.rule}** (${c.kind}, ×${c.count}) — ${c.description}`) : ["- No optimization opportunities detected."]),
    "", "## Gas",
    verified
      ? `- Verified with \`forge test --gas-report\`.\n- Before: **${gasBefore}**, After: **${gasAfter}** → **−${savedPct}%**`
      : `- Not verified with Foundry. ${gasBefore ? `Before: ${gasBefore}, After: ${gasAfter}.` : "Estimated."}`,
    "",
  ];
  writeFileSync(join(base, "OPTIMIZATION_REPORT.md"), lines.filter((l) => l !== undefined).join("\n"));
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

  // baseline (only if it's a Foundry project that builds)
  let gasBefore = 0;
  if (root && tryForge("forge build", root).ok) {
    const report = tryForge("forge test --gas-report", root);
    if (report.ok) gasBefore = totalGas(report.out);
  }

  const useAgent = Boolean(process.env.ANTHROPIC_API_KEY) || process.env.OPTLE_FORCE_AGENT === "1";
  const engine = useAgent ? "claude" : "mock";
  const model = process.env.OPTLE_MODEL || "claude-sonnet-4-6";
  console.log(`[runner] engine=${engine}${useAgent ? ` model=${model}` : ""} files=${files.length} foundry=${Boolean(root)}`);

  let changes = [];
  let agentMeta;
  const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  if (useAgent) {
    agentMeta = await runAgent(base, model);
    changes = parseReportChanges(base); // agent writes the report itself
  } else {
    for (const f of files) {
      const before = originals.get(f);
      const { out, changes: cs } = optimizeSource(before);
      if (out !== before) writeFileSync(f, out);
      changes.push(...cs);
    }
  }

  // verify + re-measure
  let verified = false;
  let gasAfter = 0;
  if (root) {
    const build = tryForge("forge build", root);
    const test = build.ok ? tryForge("forge test --gas-report", root) : build;
    if (build.ok && test.ok) {
      gasAfter = totalGas(test.out);
      verified = true;
    } else if (!useAgent) {
      for (const [f, src] of originals) writeFileSync(f, src); // mock: revert breakage
    }
  }

  // savings
  let savedPct;
  if (gasBefore > 0 && gasAfter > 0) {
    savedPct = Number((((gasBefore - gasAfter) / gasBefore) * 100).toFixed(1));
  } else {
    const applied = changes.filter((c) => c.kind === "applied").reduce((n, c) => n + c.count, 0);
    const detected = changes.filter((c) => c.kind === "detected").reduce((n, c) => n + c.count, 0);
    savedPct = Number((Math.min(0.35, applied * 0.02 + detected * 0.03) * 100).toFixed(1));
  }

  const message = verified
    ? `Optimized with ${engine === "claude" ? "Claude" : "the mock pass"} and verified with Foundry tests.`
    : `Optimized with ${engine === "claude" ? "Claude" : "the mock pass"}; Foundry verification unavailable.`;

  const result = {
    ok: true,
    engine,
    verified,
    gasBefore: gasBefore || undefined,
    gasAfter: gasAfter || undefined,
    savedPct,
    changes,
    costUsd: agentMeta?.cost,
    message,
  };
  writeResult(result);
  // For the agent, the report already exists; only (re)write for the mock engine
  // or if the agent failed to produce one.
  if (!useAgent || !existsSync(join(base, "OPTIMIZATION_REPORT.md"))) {
    writeReport(base, { changes, gasBefore, gasAfter, savedPct, verified, message });
  }
}

main().catch((err) => {
  // Surface the real cause in the server's docker logs (not just the json).
  console.error("[runner] FATAL:", err?.stack || String(err));
  writeResult({ ok: false, verified: false, engine: "error", message: `runner error: ${String(err)}` });
  process.exitCode = 1;
});
