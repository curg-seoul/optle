# Gas Optimization Patterns — Quick Reference (condensed)

Condensed for fast application to ordinary Solidity contracts. The exhaustive
version (Solady/Solmate inline-assembly + Uniswap UDVT deep dives, with full
rationale/safety and measured benchmarks) is in `pattern-corpus-full.md`; read
that only when a hot path still dominates after the patterns below are applied.

Levels: **L1** = function-body only, storage layout + external interface
unchanged. **L2** = may redesign internal storage layout; external interface
(signatures, events, view return shapes) still preserved; new-deployment only.

Verification gate (mandatory): apply ONE transform → `forge build` + `forge test`
pass → `forge snapshot`/`--gas-report` shows gas DOWN → keep it; otherwise revert.
A transform that doesn't measurably reduce gas is discarded (it only adds risk).

---

## Do these first — highest payoff, low risk

- **Pack co-mutated storage into fewer slots (L2).** The #1 lever. Fields written
  together should share a 32-byte slot (e.g. `uint128 a; uint128 b;` → 1 slot;
  `address(160)+uint64+uint32+bool` → 1 slot). Each saved cold SSTORE on a
  zero→nonzero write is ~20,000 gas. Downsize types only within proven value
  ranges (timestamps fit `uint48`; check any STORED SUM too, not just inputs).
- **`constant` / `immutable` for never-reassigned values (L1).** Values fixed at
  compile time (`constant`) or set once in the constructor (`immutable`) live in
  bytecode → no ~2100-gas SLOAD per read. `uint256 public rate = 500;` →
  `uint256 public constant RATE = 500;`.
- **Cache repeated storage reads; hoist invariants out of loops (L1).** Read a
  state var into a local once (`uint256 n = arr.length;`) instead of re-SLOADing.
  In loops the waste multiplies. Only cache a slot that can't change between reads
  (no external call / write to it in between).
- **`calldata` instead of `memory` for external read-only ref params (L1).**
  `function f(uint256[] memory a) external` → `calldata` reads in place; `memory`
  forces a full copy on entry. Only when the param isn't mutated.
- **Custom errors instead of `require(string)` (L1).** `require(c, "msg")` →
  `if (!c) revert SomeError();` + `error SomeError();`. Saves deploy + revert gas.

## Loops & arithmetic (L1; optimizer-dependent — verify via snapshot)

- **Cache array length** before the loop; **`unchecked { ++i; }`** for the counter
  (cannot overflow the length).
- **`++i` over `i++`** (no temporary copy).
- **`unchecked { }`** around arithmetic a prior `require`/condition already proves
  safe (e.g. `balance - amount` after `require(balance >= amount)`). NEVER remove
  the guard itself — wrap only the provably-safe op; document the invariant.
- **No explicit default init**: `uint256 x = 0;` → `uint256 x;`, drop `= false`,
  `for (uint256 i; ...)`.
- **`x = x + y` over `x += y` for STATE variables**; **`!= 0` over `> 0`** for
  unsigned (both small + version-dependent; keep only if the snapshot drops).

## Visibility, returns, control flow (L1)

- **`public` → `external`** for functions never called internally.
- **`payable`** on access-restricted setters (`onlyOwner`) — drops the `msg.value`
  guard (~21 gas/call). Never on user-facing functions.
- **Named return variable** to drop a redundant local + explicit `return`.
- **Fail fast**: order cheap calldata/immutable checks before non-immutable SLOAD
  checks, so failing calls skip the cold SLOAD. Preserve revert precedence if
  integrators depend on it.
- **Remove always-true conditions; order `&&`/`||` cheapest operand first.**

## Storage-shape refactors (L1)

- **Return computed values from helpers** instead of write-then-reread the same
  slot (keep the write if external readers need it).
- **Emit events before the SSTORE** to read the still-current value directly and
  drop the `oldValue` local. Preserve emit ORDER if indexers rely on it.
- **`uint256` 1/2 flag instead of `bool`** for a hot, frequently-toggled flag
  (keeps the slot non-zero, avoids the zero→nonzero SSTORE penalty). On Cancun+
  prefer transient storage (`tstore`/`tload`) for per-tx locks/counters.
- **Bitmap / packed small values (L2):** many `bool`/`uint8` flags keyed by index
  → pack 256 bools (or 32 uint8s) per slot. Replaces one SSTORE-per-flag with
  shared warm slots.

## Interface-preservation rule (critical for L2)

When a packed type is exposed via a public getter, return value, or event, KEEP
the external ABI type (e.g. `uint256`) and pack only the INTERNAL storage
representation; the getter widens packed fields back. Never change the external
struct/return shape, event topics, or function selectors.

## Hard safety rules

1. Never weaken or remove an overflow/underflow/bounds/auth check to save gas —
   those checks are the semantics.
2. L1 must not change storage slot derivation; any layout change is L2.
3. L2 is new-deployment only (storage layout changes collide with proxies).
4. Prioritize by payoff; discard any transform whose measured gas delta is noise.
