import type { WalletClient } from "viem";

export interface Change {
  rule: string;
  kind: "applied" | "detected";
  description: string;
  count: number;
}

export interface OptimizeResult {
  mock: boolean;
  original: string;
  optimized: string;
  changes: Change[];
  gasBefore: number;
  gasAfter: number;
  savedPct: number;
}

interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra: { name: string; version: string };
}

const ENDPOINT = "/api/optimize";

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

async function readResult(res: Response): Promise<OptimizeResult> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/**
 * Calls the x402-gated optimize endpoint.
 *
 * 1. POST without payment. If the server returns 200 (e.g. PAYMENT_MODE=bypass),
 *    we're done — no wallet needed.
 * 2. On 402, build & sign an EIP-3009 `transferWithAuthorization` (gasless) from
 *    the returned requirements, attach it as the X-PAYMENT header, and retry.
 *
 * Signing the EIP-712 typed data here (rather than via x402-fetch) keeps the
 * client chain-agnostic, matching our hand-rolled server — so Mantle works even
 * though x402's npm enum doesn't list it.
 */
export async function payAndOptimize(
  code: string,
  wallet: WalletClient | undefined,
  account: `0x${string}` | undefined,
  chainId: number | undefined,
): Promise<OptimizeResult> {
  const headers = { "Content-Type": "application/json" };
  const body = JSON.stringify({ code });

  // 1) try without payment
  let res = await fetch(ENDPOINT, { method: "POST", headers, body });
  if (res.status !== 402) return readResult(res);

  // 2) 402 → pay
  const challenge = await res.json();
  const reqs = challenge.accepts?.[0] as PaymentRequirements | undefined;
  if (!reqs) throw new Error("Malformed 402 response (no payment requirements).");
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

  res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...headers, "X-PAYMENT": xPayment },
    body,
  });
  return readResult(res);
}
