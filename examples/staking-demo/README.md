# staking-demo — gas-optimizer demo input

A deliberately gas-inefficient Foundry project used to demo the optimizer. Two
contracts (`src/StakingPool.sol`, `src/Airdrop.sol`) with 25 passing tests, so an
optimizer must preserve behaviour while cutting gas.

Anti-patterns (from WTF-gas-optimization's catalogue): require-strings, checked
loop counters / `i++`, init-to-default, `public` instead of `external`, unpacked
struct, `mapping<bool>` flags, repeated `SLOAD` of array length + storage in loops.

## Build a self-contained upload zip
```bash
forge install foundry-rs/forge-std   # vendor deps into lib/
zip -r staking-demo.zip foundry.toml src test lib -x 'out/*' 'cache/*'
```
Upload the zip in the app → pay → the optimizer emits an `optimized/` build.
(The repo also ships a prebuilt `apps/web/public/sample.zip` used by "Load sample".)
