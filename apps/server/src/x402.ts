import type { Request, Response, NextFunction } from "express";
import { createPublicClient, http, defineChain, type Hex } from "viem";
import { config } from "./config.js";

/**
 * HTTP 402 payment gate, paid in the native token (MNT).
 *
 * Flow:
 *   - no X-PAYMENT header → HTTP 402 with the payment requirements (payTo + amount)
 *   - X-PAYMENT present    → the payer's tx hash; we verify on-chain (via the RPC)
 *     that the tx is mined & successful, went to `payTo`, and sent >= `amount`,
 *     then next()
 *
 * Native MNT can't use EIP-3009 (no contract / no gasless authorization), so the
 * payer sends a real transfer and we read it back from the chain — no separate
 * facilitator or relayer. Each tx hash is single-use.
 */

const X402_VERSION = 1;

// Replay guard: a payment tx can only unlock one job.
const usedTx = new Set<string>();

// Read-only client on the payment chain, used to verify payment txs.
const chain = defineChain({
  id: config.payment.chainId,
  name: config.payment.network,
  nativeCurrency: { name: config.payment.symbol, symbol: config.payment.symbol, decimals: 18 },
  rpcUrls: { default: { http: [config.payment.rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(config.payment.rpcUrl) });

function buildRequirements(req: Request, amountWei: string) {
  const p = config.payment;
  return {
    scheme: "native",
    network: p.network,
    chainId: p.chainId,
    maxAmountRequired: amountWei, // wei
    resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description: "Optimize a Solidity project's gas usage",
    payTo: p.payTo,
    symbol: p.symbol,
    decimals: p.decimals,
    maxTimeoutSeconds: p.maxTimeoutSeconds,
  };
}

function send402(req: Request, res: Response, error: string, amountWei: string) {
  res.status(402).json({
    x402Version: X402_VERSION,
    error,
    accepts: [buildRequirements(req, amountWei)],
  });
}

interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  transaction?: string;
  payer?: string;
  value?: string;
}

/**
 * Verify a native MNT payment tx on-chain: it must be mined & successful, have
 * gone to `payTo`, and have sent at least `amountWei`.
 */
async function verifyPayment(txHash: Hex, payTo: string, amountWei: string): Promise<VerifyResult> {
  let required: bigint;
  try {
    required = BigInt(amountWei);
  } catch {
    return { isValid: false, invalidReason: "invalid amountWei" };
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt) return { isValid: false, invalidReason: "payment tx not found or not yet mined" };
  if (receipt.status !== "success") return { isValid: false, invalidReason: "payment tx reverted" };

  const tx = await publicClient.getTransaction({ hash: txHash });
  if (!tx.to || tx.to.toLowerCase() !== payTo.toLowerCase()) {
    return { isValid: false, invalidReason: "payment was not sent to the expected address" };
  }
  if (tx.value < required) {
    return { isValid: false, invalidReason: `payment too small (sent ${tx.value}, need ${required})` };
  }

  return { isValid: true, transaction: txHash, payer: tx.from, value: tx.value.toString() };
}

/**
 * Route-specific middleware factory: gate an endpoint behind a native payment.
 * `resolveAmount` returns the required amount in wei for this request (per-job
 * tier price); undefined → unknown resource (404).
 */
export function paymentGate(resolveAmount?: (req: Request) => string | undefined) {
  return async function gate(req: Request, res: Response, next: NextFunction) {
    const amountWei = resolveAmount ? resolveAmount(req) : "0";
    if (amountWei === undefined) {
      res.status(404).json({ error: "unknown job" });
      return;
    }

    if (config.payment.mode === "bypass") {
      next();
      return;
    }

    const header = req.header("X-PAYMENT");
    if (!header) {
      send402(req, res, "X-PAYMENT header is required (pay first)", amountWei);
      return;
    }

    let payload: { txHash?: string };
    try {
      payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      send402(req, res, "Invalid X-PAYMENT header (expected base64-encoded JSON)", amountWei);
      return;
    }

    const txHash = (payload.txHash ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      send402(req, res, "X-PAYMENT must contain a payment txHash", amountWei);
      return;
    }
    if (usedTx.has(txHash)) {
      send402(req, res, "this payment tx was already used", amountWei);
      return;
    }

    try {
      const verify = await verifyPayment(txHash as Hex, config.payment.payTo, amountWei);
      if (!verify.isValid) {
        send402(req, res, verify.invalidReason ?? "payment verification failed", amountWei);
        return;
      }
      usedTx.add(txHash);
      res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(verify)).toString("base64"));
      next();
    } catch (err) {
      res.status(502).json({ error: "payment verification error", detail: String(err) });
    }
  };
}
