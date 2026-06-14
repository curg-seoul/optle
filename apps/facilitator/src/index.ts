import "dotenv/config";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  recoverTypedDataAddress,
  defineChain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Minimal self-hosted x402 facilitator for Mantle Sepolia.
 *
 * It stands in for a third-party facilitator (Questflow et al.). The gated
 * server (apps/server) POSTs the standard x402 envelope to:
 *   POST /verify  -> off-chain: recover the EIP-712 signature, check the
 *                    authorization fields + on-chain balance/nonce.
 *   POST /settle  -> on-chain: submit transferWithAuthorization (EIP-3009),
 *                    paying gas from RELAYER_PRIVATE_KEY.
 *
 * Both receive { x402Version, paymentPayload, paymentRequirements } where
 * paymentPayload.payload = { signature, authorization:{from,to,value,
 * validAfter,validBefore,nonce} } — exactly what apps/web/src/x402.ts builds.
 */

const PORT = Number(process.env.PORT ?? 8090);
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 5003);
const NETWORK = process.env.NETWORK ?? "mantle-sepolia";
const RPC_URL = process.env.RPC_URL ?? "https://rpc.sepolia.mantle.xyz";
const rawPk = (process.env.RELAYER_PRIVATE_KEY ?? "").trim();
// Accept the key with or without the 0x prefix.
const RELAYER_PK = (rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`) as Hex;

if (!/^0x[0-9a-fA-F]{64}$/.test(RELAYER_PK)) {
  console.error("[facilitator] RELAYER_PRIVATE_KEY missing/invalid in .env (need 64 hex chars)");
  process.exit(1);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: NETWORK,
  nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const relayer = privateKeyToAccount(RELAYER_PK);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account: relayer, chain, transport: http(RPC_URL) });

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

interface Envelope {
  paymentPayload?: {
    network?: string;
    payload?: { signature?: Hex; authorization?: Authorization };
  };
  paymentRequirements?: {
    network?: string;
    payTo?: Hex;
    asset?: Hex;
    maxAmountRequired?: string;
    extra?: { name?: string; version?: string };
  };
}

/** Shared validation: recover signer + check all authorization fields. */
async function validate(body: Envelope) {
  const pp = body.paymentPayload;
  const reqs = body.paymentRequirements;
  const sig = pp?.payload?.signature;
  const auth = pp?.payload?.authorization;

  if (!pp || !reqs || !sig || !auth) {
    return { ok: false as const, reason: "malformed envelope" };
  }
  if ((pp.network ?? reqs.network) !== NETWORK || reqs.network !== NETWORK) {
    return { ok: false as const, reason: `network mismatch (expected ${NETWORK})` };
  }

  const asset = reqs.asset as Hex;
  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };

  // 1) signature recovers to `from`
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: reqs.extra?.name,
      version: reqs.extra?.version,
      chainId: CHAIN_ID,
      verifyingContract: asset,
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
    signature: sig,
  });
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false as const, reason: "signature does not match `from`" };
  }

  // 2) field checks
  if (auth.to.toLowerCase() !== (reqs.payTo as string).toLowerCase()) {
    return { ok: false as const, reason: "`to` != payTo" };
  }
  if (message.value < BigInt(reqs.maxAmountRequired ?? "0")) {
    return { ok: false as const, reason: "value < maxAmountRequired" };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now <= message.validAfter) return { ok: false as const, reason: "not yet valid" };
  if (now >= message.validBefore) return { ok: false as const, reason: "authorization expired" };

  // 3) on-chain: nonce unused + sufficient balance
  const [used, balance] = await Promise.all([
    publicClient.readContract({
      address: asset,
      abi: EIP3009_ABI,
      functionName: "authorizationState",
      args: [auth.from, auth.nonce],
    }),
    publicClient.readContract({
      address: asset,
      abi: EIP3009_ABI,
      functionName: "balanceOf",
      args: [auth.from],
    }),
  ]);
  if (used) return { ok: false as const, reason: "authorization already used/canceled" };
  if (balance < message.value) return { ok: false as const, reason: "insufficient balance" };

  return { ok: true as const, asset, auth, sig, message };
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, role: "facilitator", network: NETWORK, chainId: CHAIN_ID, relayer: relayer.address });
});

app.post("/verify", async (req, res) => {
  try {
    const v = await validate(req.body as Envelope);
    if (!v.ok) {
      res.json({ isValid: false, invalidReason: v.reason });
      return;
    }
    res.json({ isValid: true, payer: v.auth.from });
  } catch (err) {
    res.json({ isValid: false, invalidReason: `verify error: ${String(err)}` });
  }
});

// Serialize on-chain submissions so concurrent /settle calls don't race on the
// relayer's account nonce. Only the send is serialized (each gets the next
// pending nonce in order); waiting for the receipt happens outside the lock.
let txChain: Promise<unknown> = Promise.resolve();
function submitExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = txChain.then(fn, fn);
  txChain = result.then(() => undefined, () => undefined);
  return result;
}

app.post("/settle", async (req, res) => {
  try {
    const v = await validate(req.body as Envelope);
    if (!v.ok) {
      res.status(402).json({ success: false, error: v.reason });
      return;
    }
    const { r, s, v: yv } = parseSignature(v.sig);
    const vByte = Number(yv ?? 27n);

    const hash = await submitExclusive(() =>
      walletClient.writeContract({
        address: v.asset,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          v.message.from,
          v.message.to,
          v.message.value,
          v.message.validAfter,
          v.message.validBefore,
          v.message.nonce,
          vByte,
          r,
          s,
        ],
      }),
    );

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      res.status(502).json({ success: false, error: "settle tx reverted", transaction: hash });
      return;
    }
    res.json({
      success: true,
      network: NETWORK,
      transaction: hash,
      payer: v.auth.from,
    });
  } catch (err) {
    res.status(502).json({ success: false, error: `settle error: ${String(err)}` });
  }
});

app.listen(PORT, () => {
  console.log(`[facilitator] listening on :${PORT} (${NETWORK}/${CHAIN_ID}), relayer ${relayer.address}`);
});
