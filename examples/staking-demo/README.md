# staking-demo — gas-optimizer demo input

A deliberately gas-inefficient Foundry project used to demo the optimizer. The
external interface in `src/StakingPool.sol` is exercised by `test/StakingPool.t.sol`
(10 passing tests), so an optimizer must preserve behaviour while cutting gas.

Anti-patterns (from WTF-gas-optimization's catalogue): require-strings, checked
loop counters / `i++`, init-to-default, `public` instead of `external`, unpacked
struct, `mapping<bool>` flags, repeated `SLOAD` of array length + storage in loops.

## Build a self-contained upload zip
```bash
forge install foundry-rs/forge-std   # vendor deps into lib/
zip -r staking-demo.zip foundry.toml src test lib -x 'out/*' 'cache/*'
```
Upload the zip at optle.hanjun.kim → pay → the optimizer emits `optimized/`.
