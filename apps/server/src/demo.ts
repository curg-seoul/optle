import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RunnerResult } from "./jobs.js";

/**
 * Demo mode assets (OPTLE_DEMO=1). Instead of spawning the Docker runner +
 * calling Claude, the server replays a scripted "agent" run against a bundled
 * artifact (apps/server/demo/output.zip + result.json) — for recording the demo
 * video without burning API tokens or waiting on a real run.
 *
 * The diffs + savings come from a real Level 1 run captured into result.json;
 * output.zip is the downloadable optimized project.
 */

const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demo");

export const DEMO_ZIP_PATH = join(DEMO_DIR, "optimized-project.zip");

export function loadDemoResult(): RunnerResult {
  return JSON.parse(readFileSync(join(DEMO_DIR, "result.json"), "utf8")) as RunnerResult;
}

/**
 * Scripted runner log, mirroring a real Claude Agent SDK Level 1 run on the
 * bundled staking-demo. Streamed one line at a time with a random delay so the
 * UI shows the same live "agent working" flow as a real run.
 */
export const DEMO_LOG_LINES: string[] = [
  "[runner] engine=claude model=claude-sonnet-4-6 level=1 verify=false files=2 foundry=true out=optimized",
  "[agent] · Skill: solidity-gas-optimizer",
  "[agent] I'll start by exploring the project structure and reading the contracts.",
  "[agent] · Bash: find /work -type f | sort",
  "[agent] · Read: /work/.claude/skills/solidity-gas-optimizer/references/pattern-corpus.md",
  "[agent] Now let me read both contracts in parallel.",
  "[agent] · Read: /work/src/Airdrop.sol",
  "[agent] · Read: /work/src/StakingPool.sol",
  "[agent] · Read: /work/foundry.toml",
  "[agent] Let me check the test files to note any revert message dependencies before writing the optimized contracts.",
  "[agent] · Read: /work/test/Airdrop.t.sol",
  "[agent] · Read: /work/test/StakingPool.t.sol",
  "[agent] Good — both test suites use bare `vm.expectRevert()` (no selector check), so custom errors won't break them. The `memory` → `calldata` param change is transparent at the ABI layer. Now I'll write the optimized contracts and report.",
  "[agent] · Write: /work/optimized/src/Airdrop.sol",
  "[agent] · Write: /work/optimized/src/StakingPool.sol",
  "[agent] Now run a single `forge build` to confirm compilation.",
  "[agent] · Bash: forge build --root . --contracts optimized/src 2>&1",
  "[agent] Compiles cleanly. The two warnings are in the original test files (not our code). Now write the report.",
  "[agent] · Write: /work/OPTIMIZATION_REPORT.md",
  "[agent] All done — Level 1 transforms applied to both contracts: constant/immutable config, custom errors, calldata params, public→external, cached SLOADs hoisted out of loops, O(n)→O(1) membership lookups, unchecked loop counters. Original comments preserved; storage layout and external ABI unchanged.",
];
