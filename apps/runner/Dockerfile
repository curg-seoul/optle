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
