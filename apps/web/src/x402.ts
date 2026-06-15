import { createPublicClient, http, type WalletClient } from "viem";

/** Result shape produced by the runner (mirrors apps/server jobs.ts). */
export interface RunnerResult {
  ok: boolean;
  verified: boolean;
  engine?: "claude" | "mock" | "none" | "error";
  outDir?: string;
  gasBefore?: number;
  gasAfter?: number;
  savedPct?: number;
  costUsd?: number;
  changes?: { rule: string; kind: string; description: string; count: number }[];
  diffs?: { file: string; diff: string }[];
  message?: string;
}

export interface UploadResult {
  jobId: string;
  tier: "small" | "medium" | "large";
  priceMnt: number;
  amountWei: string;
  solFiles: number;
  totalBytes: number;
  level: 1 | 2;
}

export interface JobStatus {
  jobId: string;
  status: "pending" | "running" | "done" | "error";
  stage: string;
  tier: string;
  priceMnt: number;
  result?: RunnerResult;
  error?: string;
  logs?: string[];
}

/** Native-payment requirements from the 402 challenge. */
export interface PaymentRequirements {
  scheme: string; // "native"
  network: string;
  chainId: number;
  maxAmountRequired: string; // wei
  payTo: `0x${string}`;
  symbol: string;
  decimals: number;
  maxTimeoutSeconds: number;
}

// Backend base URL. Empty (default) = same-origin relative paths, which the dev
// server proxies (see vite.config.ts). In production set VITE_API_BASE.
const API = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** Step 1: upload a project .zip; server stores it and returns the tier price. */
export async function uploadProject(file: File, level: 1 | 2): Promise<UploadResult> {
  const form = new FormData();
  form.append("project", file);
  form.append("level", String(level));
  const res = await fetch(`${API}/api/upload`, { method: "POST", body: form });
  return asJson<UploadResult>(res);
}

/**
 * Step 2a: hit the gated optimize endpoint without payment to get the 402
 * challenge (or 200 if the server runs in bypass mode).
 */
export async function requestPayment(
  jobId: string,
): Promise<{ kind: "running" } | { kind: "challenge"; requirements: PaymentRequirements }> {
  const res = await fetch(`${API}/api/optimize/${jobId}`, { method: "POST" });
  if (res.status !== 402) {
    await asJson(res); // throws on non-2xx
    return { kind: "running" };
  }
  const challenge = await res.json();
  const reqs = challenge.accepts?.[0] as PaymentRequirements | undefined;
  if (!reqs) throw new Error("Malformed 402 response (no payment requirements).");
  return { kind: "challenge", requirements: reqs };
}

/**
 * Step 2b: send the native MNT payment to payTo, wait for it to be mined, then
 * retry with the tx hash in X-PAYMENT so the server can verify it on-chain.
 */
export async function payForJob(
  jobId: string,
  reqs: PaymentRequirements,
  wallet: WalletClient | undefined,
  account: `0x${string}` | undefined,
  chainId: number | undefined,
): Promise<void> {
  if (!wallet || !account || !wallet.chain) {
    throw new Error(`Connect your wallet (on ${reqs.network}) to pay.`);
  }
  if (chainId !== undefined && chainId !== reqs.chainId) {
    throw new Error(`Wrong network — switch your wallet to ${reqs.network} (chainId ${reqs.chainId}).`);
  }

  // Send the native transfer.
  const txHash = await wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: reqs.payTo,
    value: BigInt(reqs.maxAmountRequired),
  });

  // Wait until it's mined so the server can verify the receipt.
  const publicClient = createPublicClient({ chain: wallet.chain, transport: http() });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Payment transaction reverted.");

  const xPayment = btoa(JSON.stringify({ scheme: "native", txHash }));
  const res = await fetch(`${API}/api/optimize/${jobId}`, {
    method: "POST",
    headers: { "X-PAYMENT": xPayment },
  });
  await asJson(res);
}

/** Step 3: poll job status. */
export async function getStatus(jobId: string): Promise<JobStatus> {
  return asJson<JobStatus>(await fetch(`${API}/api/status/${jobId}`));
}

/** Step 4: get a presigned URL for the optimized result zip. */
export async function getDownloadUrl(jobId: string): Promise<string> {
  const { url } = await asJson<{ url: string }>(await fetch(`${API}/api/download/${jobId}`));
  return url;
}
