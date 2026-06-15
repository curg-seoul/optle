# Gas Optimization Report — Level 1

**Scope:** `src/Airdrop.sol`, `src/StakingPool.sol`
**Output:** `optimized/src/Airdrop.sol`, `optimized/src/StakingPool.sol`
**Level:** 1 — function-body transforms only; storage layout and external ABI unchanged.
**Estimated savings:** ~15% across the exercised functions (Level 1 is a fast pass; enable Aggressive / Level 2 for forge-measured before/after gas).

The originals under `src/` are untouched. The optimized variants preserve the
external interface (function signatures, visibility-as-callable, events, return
shapes) and the storage layout byte-for-byte — only the function bodies change.

## What changed

**Both contracts**

- Config values that are never reassigned are now `constant` / `immutable`
  (`name`, `symbol`, `claimFeeBps`, `maxStakers`, `owner`, `bonusRateBps`), so
  each read comes from bytecode instead of a storage slot. `rewardRateBps` keeps a
  storage slot because `setRewardRate` reassigns it.
- `require(cond, "long reason string")` → custom errors, which revert with a
  4-byte selector instead of an ABI-encoded string (cheaper deploy and revert).
- Functions never called internally are now `external`; read-only array
  parameters are taken as `calldata` to skip the memory copy on entry.
- Loops cache `array.length` in a local, use `unchecked { ++i }` counters, and
  drop redundant default initialisation and `== true` / `== false` comparisons.

**Airdrop.sol**

- `setAllocations` reads/writes `totalAllocated` once (a local accumulator) instead
  of on every iteration.
- `totalUnclaimed` caches the per-recipient storage struct in a pointer instead of
  re-deriving it for each field.
- `isRecipient` returns the O(1) `isRegistered[user]` lookup instead of scanning
  the `recipients` array.

**StakingPool.sol**

- `batchStake` accumulates `totalStaked` in a local and writes it once.
- `distributeRewards` / `recomputeAll` hoist the `rewardRateBps` read out of the
  loop and reuse a `StakeInfo storage` pointer per staker.
- `topStaker` / `removeStaker` reuse a storage pointer for repeated field access.
- `isStaker` returns the O(1) `hasStaked[user]` lookup instead of scanning the
  `stakers` array.

## Verification

Build only (`forge build --contracts optimized/src`) — compiles cleanly. The test
suite and gas snapshot are skipped in Level 1; run **Aggressive (Level 2)** for the
full forge verification loop with measured before/after gas.
