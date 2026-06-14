# Isolated optimization runner: Foundry (forge) + Node, run per job with
# --network none on a bind-mounted /work directory.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install Foundry (forge/cast/anvil).
ENV PATH="/root/.foundry/bin:${PATH}"
# The container runs as root; tell Claude Code it's a sandbox so the agent's
# --dangerously-skip-permissions is allowed (it refuses as root otherwise).
ENV IS_SANDBOX=1
RUN curl -L https://foundry.paradigm.xyz | bash && foundryup

# Pre-cache common solc versions into the image (~/.svm). Per-job containers are
# ephemeral, so without this every job re-downloads solc on first `forge` call —
# the #1 cause of multi-minute hangs on slow networks (foundry #8507/#5601/#4747).
# Baked in at build time, runtime `forge` finds the compiler locally and never
# touches the network. Unlisted versions still fall back to a runtime download.
RUN mkdir -p /tmp/sc/src && cd /tmp/sc \
  && printf '[profile.default]\nsrc = "src"\n' > foundry.toml \
  && for v in 0.8.19 0.8.20 0.8.21 0.8.22 0.8.23 0.8.24 0.8.25 0.8.26 0.8.27 0.8.28; do \
       printf '// SPDX-License-Identifier: MIT\npragma solidity %s;\ncontract C {}\n' "$v" > src/C.sol; \
       forge build --use "$v" >/dev/null 2>&1 || true; \
     done \
  && cd / && rm -rf /tmp/sc

# Bound fuzz/invariant runs so a heavy uploaded test suite can't run for minutes.
ENV FOUNDRY_FUZZ_RUNS=64

# Build context is the repo root (so we can also pull in the skill file).
#   docker build -t optle-runner -f apps/runner/Dockerfile .
WORKDIR /app
COPY apps/runner/package.json ./
# Claude Agent SDK (real engine). Installed here; only loaded when ANTHROPIC_API_KEY is set.
RUN npm install --omit=dev
COPY apps/runner/run.mjs ./
# The solidity-gas-optimizer skill (SKILL.md + references/), now an extracted dir
# in the repo. run.mjs copies it into the project's .claude/skills at runtime so
# the agent loads it natively (references resolve relative). Dir name = skill name.
COPY skills/gas-optimizer /app/skill/solidity-gas-optimizer
ENV OPTLE_SKILL_SRC=/app/skill/solidity-gas-optimizer

# Operates on the mounted /work directory.
CMD ["node", "/app/run.mjs"]
