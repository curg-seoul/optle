import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { config } from "./config.js";
import { inputKey, outputKey, getToFile, putFile } from "./cos.js";
import type { ProjectSizing } from "./pricing.js";

/**
 * In-memory job store + orchestration of the isolated optimization runner.
 *
 * Per job we keep a working dir at <jobsDir>/<id>/work (mounted into this
 * container, and bind-mounted from the host so the sibling runner container can
 * see it). The runner does the actual optimize+verify offline; the server moves
 * data in/out of COS and zips the result.
 *
 * State is in-memory and volatile (fine for the demo — files persist in COS).
 */

export type JobStatus = "pending" | "running" | "done" | "error";
export type JobStage =
  | "queued"
  | "downloading"
  | "optimizing"
  | "verifying"
  | "packaging"
  | "complete";

export interface RunnerResult {
  ok: boolean;
  verified: boolean;
  gasBefore?: number;
  gasAfter?: number;
  savedPct?: number;
  changes?: { rule: string; kind: string; description: string; count: number }[];
  message?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  stage: JobStage;
  sizing: ProjectSizing;
  level: 1 | 2; // optimization depth (1 = function-body only, 2 = storage redesign)
  result?: RunnerResult;
  error?: string;
  paid: boolean;
  logs: string[]; // live runner output (capped ring buffer)
}

const jobs = new Map<string, Job>();
const MAX_LOGS = 1000;

function log(job: Job, line: string) {
  job.logs.push(line);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
}

export function createJob(id: string, sizing: ProjectSizing, level: 1 | 2): Job {
  const job: Job = { id, status: "pending", stage: "queued", sizing, level, paid: false, logs: [] };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

const workDir = (id: string) => join(config.runner.jobsDir, id, "work");
const hostWorkDir = (id: string) => join(config.runner.hostJobsDir, id, "work");
const localInputZip = (id: string) => join(config.runner.jobsDir, id, "input.zip");
const localOutputZip = (id: string) => join(config.runner.jobsDir, id, "output.zip");

/** Run `docker run` for the runner image, resolving on exit or rejecting on timeout. */
function runContainer(id: string, tier: string, level: 1 | 2, onLog: (line: string) => void): Promise<void> {
  const r = config.runner;
  const name = `optle-${id}`;
  const aiKey = config.anthropicApiKey;
  const oauthToken = config.oauthToken;
  // Prefer subscription token (no API credits) when present; else the API key.
  const authEnv = oauthToken
    ? ["-e", `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`]
    : aiKey && aiKey !== "sk-ant-REPLACE_ME"
      ? ["-e", `ANTHROPIC_API_KEY=${aiKey}`]
      : [];
  // OPTLE_ENGINE=mock forces the offline mock optimizer even when keys are set
  // (public site); "auto" uses the agent whenever a key/token is present.
  const useAgent = config.runner.engine !== "mock" && authEnv.length > 0;
  // Larger projects get the stronger model.
  const model = process.env.CLAUDE_MODEL || (tier === "large" ? "claude-opus-4-8" : "claude-sonnet-4-6");

  const args = [
    "run", "--rm", "--name", name,
    // The real agent needs to reach the Anthropic API; the mock pass stays offline.
    ...(useAgent ? [] : ["--network", "none"]),
    "--memory", r.memory,
    "--cpus", r.cpus,
    "--pids-limit", "256",
    "-v", `${hostWorkDir(id)}:/work`,
    ...(useAgent ? [...authEnv, "-e", `OPTLE_MODEL=${model}`, "-e", `OPTLE_LEVEL=${level}`] : []),
    r.image,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    // Split stream chunks into whole lines and forward each to onLog + console.
    const lineSplitter = (prefix: string) => {
      let buf = "";
      return (d: Buffer) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          if (!line.trim()) continue;
          console.log(`[runner ${id}] ${line}`);
          onLog(prefix + line);
        }
      };
    };
    const onStderr = lineSplitter("");
    child.stdout.on("data", lineSplitter(""));
    child.stderr.on("data", (d) => { stderr += d.toString(); onStderr(d); });

    const timer = setTimeout(() => {
      spawn("docker", ["kill", name]); // best-effort
      reject(new Error(`runner timed out after ${r.timeoutMs}ms`));
    }, r.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`runner exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Background pipeline: COS in -> runner -> COS out. Never throws (sets status). */
export async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "running";
  const jobRoot = join(config.runner.jobsDir, id);
  const setStage = (s: JobStage) => { job.stage = s; log(job, `── ${s} ──`); };

  try {
    // 1) fetch + unzip input
    setStage("downloading");
    mkdirSync(workDir(id), { recursive: true });
    await getToFile(inputKey(id), localInputZip(id));
    new AdmZip(localInputZip(id)).extractAllTo(workDir(id), /* overwrite */ true);

    // 2) run the isolated optimizer (snapshot -> optimize -> verify loop)
    setStage("optimizing");
    await runContainer(id, job.sizing.tier, job.level, (line) => log(job, line));
    setStage("verifying");

    // 3) read the runner's machine-readable result
    const resultPath = join(workDir(id), "OPTLE_RESULT.json");
    if (existsSync(resultPath)) {
      job.result = JSON.parse(readFileSync(resultPath, "utf8")) as RunnerResult;
      rmSync(resultPath, { force: true }); // keep it out of the downloadable zip
    }

    // 4) package work dir -> output.zip -> COS (skip build artifacts / vcs / deps)
    setStage("packaging");
    const outZip = new AdmZip();
    const SKIP = /(^|\/)(out|cache|broadcast|node_modules|\.git|\.claude)(\/|$)/;
    outZip.addLocalFolder(workDir(id), undefined, (entry) => !SKIP.test(entry));
    outZip.writeZip(localOutputZip(id));
    await putFile(outputKey(id), localOutputZip(id));

    setStage("complete");
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    log(job, `✗ error: ${job.error}`);
    console.error(`[job ${id}] failed:`, job.error);
  } finally {
    // Clean the working dir; input/output persist in COS.
    rmSync(jobRoot, { recursive: true, force: true });
  }
}
