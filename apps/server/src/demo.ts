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

export const DEMO_ZIP_PATH = join(DEMO_DIR, "output.zip");

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
  "[agent] Both contracts read. These are deliberately inefficient — long require strings, mapping<bool> flags, and loops that re-read storage and array length each iteration.",
  "[agent] Level 1 plan (no storage-layout or ABI changes): constant/immutable, cached SLOADs, custom errors, calldata params, public→external, unchecked loop counters.",
  "[agent] Airdrop.sol — name/claimFeeBps → constant, owner → immutable; setAllocations params memory → calldata; require strings → custom errors; hoist totalAllocated SLOAD/SSTORE out of the loop; cache length + unchecked {++i}.",
  "[agent] · Write: optimized/src/Airdrop.sol",
  "[agent] StakingPool.sol — cache rewardPerToken / lastUpdateTime SLOADs in the reward path; public → external; named return variables; custom errors; unchecked loop counters; drop zero-init.",
  "[agent] · Write: optimized/src/StakingPool.sol",
  "[agent] Writing the optimization report.",
  "[agent] · Write: OPTIMIZATION_REPORT.md",
  "[agent] Done — applied Level 1 gas optimizations to 2 contracts. Originals under src/ are untouched; the optimized build is in optimized/.",
];
