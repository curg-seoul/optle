import type { WalletClient } from "viem";

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
  message?: string;
}

export interface UploadResult {
  jobId: string;
  tier: "small" | "medium" | "large";
  priceUsd: number;
  solFiles: number;
  totalBytes: number;
}

export interface JobStatus {
  jobId: string;
  status: "pending" | "running" | "done" | "error";
  stage: string;
  tier: string;
  priceUsd: number;
  result?: RunnerResult;
  error?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra: { name: string; version: string };
}

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** Step 1: upload a project .zip; server stores it and returns the tier price. */
export async function uploadProject(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("project", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  return asJson<UploadResult>(res);
}

/**
 * Step 2a: hit the gated optimize endpoint without payment to get the 402
 * challenge (or 200 if the server runs in bypass mode).
 */
export async function requestPayment(
  jobId: string,
): Promise<{ kind: "running" } | { kind: "challenge"; requirements: PaymentRequirements }> {
  const res = await fetch(`/api/optimize/${jobId}`, { method: "POST" });
  if (res.status !== 402) {
    await asJson(res); // throws on non-2xx
    return { kind: "running" };
  }
  const challenge = await res.json();
  const reqs = challenge.accepts?.[0] as PaymentRequirements | undefined;
  if (!reqs) throw new Error("Malformed 402 response (no payment requirements).");
  return { kind: "challenge", requirements: reqs };
}

/** Step 2b: sign the EIP-3009 authorization and retry with X-PAYMENT. */
export async function payForJob(
  jobId: string,
  reqs: PaymentRequirements,
  wallet: WalletClient | undefined,
  account: `0x${string}` | undefined,
  chainId: number | undefined,
): Promise<void> {
  if (!wallet || !account || !chainId) {
    throw new Error("Connect your wallet (on Mantle Sepolia) to pay.");
  }

  const authorization = {
    from: account,
    to: reqs.payTo,
    value: BigInt(reqs.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + (reqs.maxTimeoutSeconds ?? 60)),
    nonce: randomNonce(),
  };

  const signature = await wallet.signTypedData({
    account,
    domain: {
      name: reqs.extra.name,
      version: reqs.extra.version,
      chainId,
      verifyingContract: reqs.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const paymentPayload = {
    x402Version: 1,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
  const xPayment = btoa(JSON.stringify(paymentPayload));

  const res = await fetch(`/api/optimize/${jobId}`, {
    method: "POST",
    headers: { "X-PAYMENT": xPayment },
  });
  await asJson(res);
}

/** Step 3: poll job status. */
export async function getStatus(jobId: string): Promise<JobStatus> {
  return asJson<JobStatus>(await fetch(`/api/status/${jobId}`));
}

/** Step 4: get a presigned URL for the optimized result zip. */
export async function getDownloadUrl(jobId: string): Promise<string> {
  const { url } = await asJson<{ url: string }>(await fetch(`/api/download/${jobId}`));
  return url;
}
