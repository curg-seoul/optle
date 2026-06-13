/**
 * Gas-optimization PoC.
 *
 * Flow (mirrors the planned server):
 *   1. copy the sample Foundry project into a throwaway temp dir
 *   2. measure baseline gas with `forge test --gas-report`
 *   3. run a Claude agent (Agent SDK) in that dir with the gas-optimizer skill,
 *      letting it edit the contracts and run `forge` itself
 *   4. re-measure gas
 *   5. print a before/after diff
 *
 * Auth: uses ANTHROPIC_API_KEY if set, otherwise the installed `claude` CLI login.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, readFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// Make `forge` reachable for both this script and the agent's Bash tool.
process.env.PATH = `${join(process.env.HOME!, ".foundry/bin")}:${process.env.PATH}`;

function runForge(cwd: string): string {
  try {
    return execSync("forge test --gas-report", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** Pull `Function Name -> avg gas` out of a `forge test --gas-report` table. */
function parseGas(report: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of report.split("\n")) {
    // table rows look like: | computeTotal | 177483 | 177483 | 177483 | 177483 | 1 |
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 7) continue;
    const name = cells[1];
    const avg = Number(cells[3]);
    if (!name || name === "Function Name" || Number.isNaN(avg)) continue;
    // skip non-function rows: contract header, deployment cost/size, bare numbers
    if (/Contract|Deployment|^\d+$/.test(name)) continue;
    out[name] = avg;
  }
  return out;
}

function passing(report: string): number {
  const m = report.match(/(\d+)\s+passed/);
  return m ? Number(m[1]) : -1;
}

/** Skill body with the YAML frontmatter stripped. */
function skillBody(): string {
  const raw = readFileSync(join(HERE, "..", "skills", "gas-optimizer", "SKILL.md"), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "gasopt-"));
  cpSync(join(HERE, "sample"), work, { recursive: true });
  console.log(`workdir: ${work}\n`);

  console.log("── measuring baseline gas ──");
  const before = runForge(work);
  const beforeGas = parseGas(before);
  const beforePass = passing(before);
  console.log(`baseline: ${beforePass} tests passing`);
  console.log(beforeGas, "\n");

  console.log("── running gas-optimizer agent ──\n");
  const prompt =
    "This is a Foundry project. Optimize the gas usage of the Solidity " +
    "contracts under src/ following your gas-optimizer instructions. Verify " +
    "with `forge test --gas-report` that all tests still pass and gas went " +
    "down, then write OPTIMIZATION_REPORT.md.";

  let agentText = "";
  let cost = 0;
  let turns = 0;

  for await (const msg of query({
    prompt,
    options: {
      cwd: work,
      model: "claude-opus-4-8",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      systemPrompt: { type: "preset", preset: "claude_code", append: skillBody() },
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content as any[]) {
        if (block.type === "text" && block.text.trim()) {
          agentText = block.text;
          console.log(`\x1b[36m${block.text.trim()}\x1b[0m`);
        } else if (block.type === "tool_use") {
          const arg =
            block.name === "Bash"
              ? block.input.command
              : block.input.file_path ?? JSON.stringify(block.input).slice(0, 80);
          console.log(`  \x1b[90m· ${block.name}: ${arg}\x1b[0m`);
        }
      }
    } else if (msg.type === "result") {
      turns = msg.num_turns;
      if (msg.subtype === "success") {
        cost = msg.total_cost_usd;
      } else {
        console.error(`\n[agent ended: ${msg.subtype}]`);
      }
    }
  }

  console.log("\n── measuring optimized gas ──");
  const after = runForge(work);
  const afterGas = parseGas(after);
  const afterPass = passing(after);
  console.log(`after: ${afterPass} tests passing`);

  // Report.
  console.log("\n══════════════ RESULT ══════════════");
  console.log(`tests passing: ${beforePass} → ${afterPass}` + (afterPass === beforePass && afterPass > 0 ? "  ✅ behavior preserved" : "  ⚠️ CHECK"));
  console.log(`agent turns: ${turns}   cost: $${cost.toFixed(4)}`);
  console.log("\nper-function avg gas (before → after):");
  const names = new Set([...Object.keys(beforeGas), ...Object.keys(afterGas)]);
  let totalBefore = 0;
  let totalAfter = 0;
  for (const name of names) {
    const b = beforeGas[name] ?? 0;
    const a = afterGas[name] ?? 0;
    totalBefore += b;
    totalAfter += a;
    const delta = b ? (((a - b) / b) * 100).toFixed(1) : "n/a";
    const arrow = a < b ? "↓" : a > b ? "↑" : "=";
    console.log(`  ${name.padEnd(16)} ${String(b).padStart(8)} → ${String(a).padStart(8)}  ${arrow} ${delta}%`);
  }
  const overall = totalBefore ? (((totalAfter - totalBefore) / totalBefore) * 100).toFixed(1) : "n/a";
  console.log(`  ${"TOTAL".padEnd(16)} ${String(totalBefore).padStart(8)} → ${String(totalAfter).padStart(8)}  ${overall}%`);

  const reportPath = join(work, "OPTIMIZATION_REPORT.md");
  if (existsSync(reportPath)) {
    console.log(`\nOPTIMIZATION_REPORT.md written ✅  (${reportPath})`);
  }
  console.log(`\noptimized project kept at: ${work}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
