---
name: gas-optimizer
description: Apply gas optimizations to Solidity contracts without changing their behavior, and verify the savings with Foundry tests. Use when asked to reduce gas usage of Solidity/Foundry projects.
---

# Solidity Gas Optimizer

You optimize the gas usage of Solidity smart contracts **without changing their
observable behavior or public interface**. Correctness is non-negotiable: a
change that saves gas but breaks a test is a failed change and must be reverted.

## Workflow

1. **Survey.** Use `glob`/`grep` to find every `*.sol` file under `src/` (ignore
   `lib/`, `test/`, `script/`). Read them.
2. **Detect Foundry.** A `foundry.toml` at the project root means tests can verify
   your work. If present, run `forge test --gas-report` first and keep the output
   as the **baseline** — note the gas numbers for each function.
3. **Optimize.** Apply the techniques below to the contracts in `src/`. Make small,
   focused edits. Do not change function signatures, visibility-driven behavior,
   events, or storage layout semantics that callers depend on.
4. **Verify after every meaningful change** (Foundry projects):
   - `forge build` must succeed.
   - `forge test` must still pass — same number of passing tests as baseline.
   - If a change breaks compilation or a test, **revert that change** and move on.
5. **Re-measure.** Run `forge test --gas-report` again and compare to the baseline.
6. **Report.** Write `OPTIMIZATION_REPORT.md` at the project root summarizing each
   change, why it saves gas, and the before/after gas numbers per function.

If there is no `foundry.toml`, skip the test/verify steps, apply only changes you
are confident preserve behavior, and say in the report that gas was not verified.

## Optimization techniques

Apply these where they fit; never apply one that changes behavior:

- **Cache storage reads.** Reading a state variable (`SLOAD`) repeatedly — e.g.
  `arr.length` in a loop condition — is expensive. Cache it in a local once.
- **Cache storage arrays in memory** when read multiple times and not mutated.
- **`unchecked` for safe arithmetic.** Loop counters that cannot overflow
  (`i` bounded by `length`) belong in an `unchecked { ++i; }` block.
- **`++i` over `i++`** in loops (avoids a temporary copy).
- **Custom errors over `require(string)`.** Replace `require(cond, "msg")` with
  `if (!cond) revert SomeError();` and a declared `error SomeError();`.
- **`constant` / `immutable`** for values fixed at compile time or set once in the
  constructor.
- **`calldata` over `memory`** for reference-type arguments of `external` functions.
- **Tighter storage packing** by reordering struct/state-variable fields so they
  share 32-byte slots (only when it does not break expected layout).
- **`public` → `external`** for functions never called internally.
- **Remove redundant zero-initialization** (`uint256 x = 0;` → `uint256 x;`).
- **Short-circuit ordering** in `&&` / `||`: cheapest / most-likely-decisive first.

## Hard rules

- Preserve the public ABI (function names, parameters, return types, visibility
  that affects external callability) and all emitted events.
- Never weaken a check or remove validation to save gas.
- Prefer several small verified edits over one large rewrite.
- The final state of the project MUST compile and pass all tests it passed at the
  baseline. If you cannot achieve that, revert to the last good state.
