import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { paymentGate } from "./x402.js";
import { priceZip } from "./pricing.js";
import { cosEnabled, inputKey, outputKey, putFile, presignedGetUrl } from "./cos.js";
import { createJob, getJob, runJob } from "./jobs.js";

const app = express();
// Behind Caddy (and Netlify's proxy): read X-Forwarded-Proto/Host so the 402
// `resource` URL reflects the public https origin, not the internal one.
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// Minimal CORS so a separately-hosted frontend can call us (dev uses a Vite
// proxy, so this mainly matters for direct cross-origin calls). X-PAYMENT is a
// custom request header; X-PAYMENT-RESPONSE must be readable by the client.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
  res.header("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Up to 50 MB project zips, held in memory then written to a temp file.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Unprotected health check.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: config.payment.network,
    chainId: config.payment.chainId,
    asset: config.payment.asset.name,
    cos: cosEnabled,
  });
});

/**
 * Step 1: upload a project .zip. We store it in COS and inspect it to compute
 * the size-based price, returned so the UI can show the amount before payment.
 */
app.post("/api/upload", upload.single("project"), async (req, res) => {
  if (!cosEnabled) {
    res.status(503).json({ error: "storage not configured (COS_* env missing)" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "no file uploaded (field name must be 'project')" });
    return;
  }

  const jobId = randomUUID();
  const tmp = join(tmpdir(), `${jobId}.zip`);
  try {
    writeFileSync(tmp, req.file.buffer);
    const sizing = priceZip(tmp);
    if (sizing.solFiles === 0) {
      res.status(400).json({ error: "no Solidity (.sol) source files found in the zip" });
      return;
    }
    await putFile(inputKey(jobId), tmp);
    createJob(jobId, sizing);
    res.json({
      jobId,
      tier: sizing.tier,
      priceUsd: sizing.priceUsd,
      solFiles: sizing.solFiles,
      totalBytes: sizing.totalBytes,
    });
  } catch (err) {
    res.status(500).json({ error: "upload failed", detail: String(err) });
  } finally {
    rmSync(tmp, { force: true });
  }
});

/**
 * Step 2: pay for and start the optimization job. x402-gated at the tier price.
 * On successful payment we kick off the runner in the background and return.
 */
app.post(
  "/api/optimize/:jobId",
  paymentGate((req) => getJob(req.params.jobId)?.sizing.amountBaseUnits),
  (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "unknown job" });
      return;
    }
    if (!job.paid) {
      job.paid = true;
      job.status = "running";
      void runJob(job.id); // background; status via /api/status
    }
    res.json({ jobId: job.id, status: job.status });
  },
);

// Step 3: poll job status.
app.get("/api/status/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    tier: job.sizing.tier,
    priceUsd: job.sizing.priceUsd,
    result: job.result,
    error: job.error,
  });
});

// Step 4: get a presigned URL to download the optimized result zip.
app.get("/api/download/:jobId", async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  if (job.status !== "done") {
    res.status(409).json({ error: `job not ready (status: ${job.status})` });
    return;
  }
  try {
    const url = await presignedGetUrl(outputKey(job.id));
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "could not sign download url", detail: String(err) });
  }
});

app.listen(config.port, () => {
  const p = config.payment;
  console.log(`optle optimize server → http://localhost:${config.port}`);
  console.log(`  network:     ${p.network} (chainId ${p.chainId})`);
  console.log(`  pricing:     tier-based ($0.5 / $3 / $10), paid in ${p.asset.name}`);
  console.log(`  pay to:      ${p.payTo}`);
  console.log(`  facilitator: ${config.facilitator.url}${config.facilitator.apiKey ? "" : "  (no API key set)"}`);
  console.log(`  COS:         ${cosEnabled ? `${config.cos.bucket} (${config.cos.region})` : "NOT configured"}`);
  console.log(`  runner:      ${config.runner.image} (jobs at ${config.runner.jobsDir})`);
  if (config.payment.mode === "bypass") {
    console.warn("  ⚠️  PAYMENT_MODE=bypass — x402 gate is OFF (local demo only).");
  }
});
