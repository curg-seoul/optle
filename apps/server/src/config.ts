import "dotenv/config";

/**
 * Server + x402 payment config, loaded from .env (placeholders are fine to BOOT).
 * No secrets hardcoded. Defaults target Mantle Sepolia testnet.
 */
const decimals = Number(process.env.PAYMENT_ASSET_DECIMALS ?? 6);
const priceHuman = Number(process.env.PAYMENT_PRICE ?? 0.01);

export const config = {
  port: Number(process.env.PORT ?? 8080),

  payment: {
    // "enforce" (default) = real x402 gate. "bypass" = skip payment for local
    // UI demos when no facilitator is available. NEVER ship "bypass".
    mode: (process.env.PAYMENT_MODE ?? "enforce") as "enforce" | "bypass",

    // Network identifier as the FACILITATOR expects it (friendly name or CAIP-2
    // "eip155:5003"). x402's typed npm enum lacks Mantle, so we drive the wire
    // protocol ourselves — see x402.ts.
    network: process.env.PAYMENT_NETWORK ?? "mantle-sepolia",
    chainId: Number(process.env.PAYMENT_CHAIN_ID ?? 5003), // Mantle Sepolia

    payTo: process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000",

    // Chosen coin: USDC — the canonical EIP-3009 token the x402 `exact` scheme
    // assumes (gasless transferWithAuthorization). Fill the real Mantle Sepolia
    // address; it MUST implement EIP-3009.
    asset: {
      address: process.env.PAYMENT_ASSET_ADDRESS ?? "0xUSDC_ON_MANTLE_SEPOLIA",
      name: process.env.PAYMENT_ASSET_NAME ?? "USDC",
      decimals,
      eip712Version: process.env.PAYMENT_EIP712_VERSION ?? "2",
    },

    priceHuman,
    // human price → token base units (0.01 * 10^6 = 10000)
    amountBaseUnits: Math.round(priceHuman * 10 ** decimals).toString(),
    maxTimeoutSeconds: 60,
  },

  facilitator: {
    // Questflow is the multi-chain facilitator that announced Mantle support.
    url: process.env.FACILITATOR_URL ?? "https://facilitator.questflow.ai",
    apiKey: process.env.FACILITATOR_API_KEY, // Bearer; required for live verify/settle
  },

  // Tencent COS — stores each job's input.zip / output.zip.
  cos: {
    secretId: process.env.COS_SECRET_ID ?? "",
    secretKey: process.env.COS_SECRET_KEY ?? "",
    bucket: process.env.COS_BUCKET ?? "", // e.g. optle-jobs-1250000000
    region: process.env.COS_REGION ?? "ap-singapore",
  },

  // Isolated optimization runner (sibling Docker container per job).
  runner: {
    image: process.env.RUNNER_IMAGE ?? "optle-runner",
    // "auto" (default): real Claude agent if a key/token is set, else mock.
    // "mock": always run the offline mock optimizer (no AI cost) — use this on
    // the public site; unset/auto for the real-AI demo recording.
    engine: process.env.OPTLE_ENGINE ?? "auto",
    // Where the server keeps per-job working dirs (mounted into this container).
    jobsDir: process.env.JOBS_DIR ?? "/jobs",
    // The SAME directory's path on the Docker host, so `docker run -v` resolves
    // it correctly when we spawn a sibling container. Falls back to jobsDir when
    // the server runs directly on the host (no container).
    hostJobsDir: process.env.HOST_JOBS_DIR ?? process.env.JOBS_DIR ?? "/jobs",
    timeoutMs: Number(process.env.RUNNER_TIMEOUT_MS ?? 10 * 60 * 1000),
    memory: process.env.RUNNER_MEMORY ?? "2g",
    cpus: process.env.RUNNER_CPUS ?? "2",
  },

  // AI — read only after deploy; dev uses the mock (no API calls).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  // Subscription auth alternative to a (credit-billed) API key — generate with
  // `claude setup-token`. If set, the runner uses it instead of the API key.
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  model: process.env.CLAUDE_MODEL ?? "claude-opus-4-8",
};
