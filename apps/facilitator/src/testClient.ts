// One-shot end-to-end test: acts as the browser. Fetches the 402 challenge,
// signs the EIP-3009 authorization with the payer key, posts X-PAYMENT, and
// prints the result. Run: PAYER_PK=0x... tsx src/testClient.ts
import { privateKeyToAccount } from "viem/accounts";
import { toHex, type Hex } from "viem";

const SERVER = process.env.SERVER ?? "http://localhost:8080";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 5003);
const PAYER_PK = process.env.PAYER_PK as Hex;
const payer = privateKeyToAccount(PAYER_PK);

function randomNonce(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

const r1 = await fetch(`${SERVER}/api/optimize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: "contract C { uint256 x; }" }),
});
console.log("first request status:", r1.status);
const challenge = await r1.json();
const reqs = challenge.accepts[0];

const authorization = {
  from: payer.address,
  to: reqs.payTo as Hex,
  value: BigInt(reqs.maxAmountRequired),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + (reqs.maxTimeoutSeconds ?? 60)),
  nonce: randomNonce(),
};

const signature = await payer.signTypedData({
  domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: CHAIN_ID, verifyingContract: reqs.asset },
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
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

const r2 = await fetch(`${SERVER}/api/optimize`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-PAYMENT": xPayment },
  body: JSON.stringify({ code: "contract C { uint256 x; }" }),
});
console.log("paid request status:", r2.status);
const settleHeader = r2.headers.get("X-PAYMENT-RESPONSE");
if (settleHeader) {
  console.log("settlement:", Buffer.from(settleHeader, "base64").toString("utf8"));
}
const out = await r2.json();
console.log("body:", JSON.stringify(out).slice(0, 300));
