import "dotenv/config";

/**
 * Server + payment config, loaded from .env (placeholders are fine to BOOT).
 * No secrets hardcoded. Defaults target Mantle Sepolia testnet.
 *
 * Payment is in the native token (MNT): the payer sends MNT to `payTo` and the
 * server verifies that transaction on-chain via the RPC (no EIP-3009 / no settle /
 * no separate facilitator).
 */
export const config = {
  port: Number(process.env.PORT ?? 8080),

  payment: {
    // "enforce" (default) = real payment gate. "bypass" = skip payment for local
    // UI demos. NEVER ship "bypass".
    mode: (process.env.PAYMENT_MODE ?? "enforce") as "enforce" | "bypass",

    network: process.env.PAYMENT_NETWORK ?? "mantle-sepolia",
    chainId: Number(process.env.PAYMENT_CHAIN_ID ?? 5003), // Mantle Sepolia

    // RPC used to verify the payment tx on-chain (receipt + recipient + amount).
    rpcUrl: process.env.RPC_URL ?? "https://rpc.sepolia.mantle.xyz",

    // Wallet that receives payments (native MNT).
    payTo: process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000",

    // Native token shown in the UI / 402 challenge.
    symbol: process.env.PAYMENT_SYMBOL ?? "MNT",
    decimals: 18,
    maxTimeoutSeconds: 120,
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
    // Applies to LEVEL 2 only. "on" (default): Level 2 runs the full Foundry
    // verification loop (snapshot → test → re-measure). "off": Level 2 skips
    // forge test/fuzz too (fast mode, no verified gas). LEVEL 1 NEVER runs forge
    // regardless — it applies a few safe source-level transforms in one pass.
    verify: (process.env.OPTLE_VERIFY ?? "on") !== "off",
    // Demo mode (OPTLE_DEMO=1): skip Docker/Claude/COS and replay a scripted
    // agent run against the bundled artifact (apps/server/demo) — for recording
    // the demo video. Payment stays real; only the optimize step is mocked.
    demo: process.env.OPTLE_DEMO === "1",
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
