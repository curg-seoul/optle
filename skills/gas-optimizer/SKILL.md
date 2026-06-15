---
name: solidity-gas-optimizer
description: >-
  Transforms a Solidity contract into a gas-optimized version using inline-assembly,
  storage-packing, and source-level refactors mined from Solady, Uniswap V3/V4, and Cyfrin Solodit
  audit findings, while preserving the external interface and keeping the original source as the
  human-maintained source of truth. Use whenever the user wants to reduce gas of a Solidity
  contract, apply inline assembly / Yul, pack storage slots, use bitpacked structs or UDVTs, apply
  source-level refactors (cache SLOADs, constant/immutable, calldata, reorder checks, combine
  calls), or run an automated pass that emits the optimized contract to a separate directory and
  verifies it against existing unit tests with a forge gas snapshot. Trigger on cues like
  "gas 최적화", "inline assembly로 줄여줘", "struct packing", "이 컨트랙트 가스 줄이는 버전 만들어줘",
  "optimize this contract", "Solady 스타일로", or a .sol file with a request to make it cheaper.
  NEW-DEPLOYMENT only; does not handle upgrade/proxy storage-collision safety.
---

# Solidity Gas Optimizer

Produce a gas-optimized variant of a Solidity contract by applying battle-tested
inline-assembly, storage-packing, and source-level refactor patterns, without changing what the
contract does as seen from the outside.

## Core model

The developer owns the original `.sol` file: it holds the business logic and is what humans
read and maintain. This skill produces a SEPARATE optimized artifact in its own directory.
Only the optimized artifact is deployed. The original is never edited in place.

```
src/Token.sol            <- human-maintained source of truth (untouched)
optimized/Token.sol      <- generated, deployed; same external interface
```

Two optimization levels, chosen by the user. **The level decides whether forge runs at all:**

- **Level 1 (default)** — function bodies only, applied as a FAST single pass with **no forge
  invocation** (no `forge build`/`test`/`snapshot`/fuzz) and **no per-transform verification
  loop**. Storage layout AND external interface (function signatures, events, view return shapes)
  are preserved byte-for-byte. Its safety comes from restricting to the provably-safe staple
  refactors below — none of which remove a runtime check — so the verification gate is not
  required. Use this for quick/demo runs and to keep cost and latency low.
- **Level 2 (opt-in)** — external interface still preserved, but internal storage structure may
  be redesigned (slot packing, bitmaps, UDVTs, data-structure swaps). Higher payoff, higher risk,
  so it runs through the full verification gate below. **New-deployment only** — changing storage
  layout collides with any already deployed proxy.

If the user has not said which level, default to Level 1.

### Level 1 staple transforms (safe, no gate needed)

Apply only these source-level, behaviour-preserving refactors, and only where they clearly fit —
a handful of edits is enough, do not over-optimize:

- cache repeated SLOADs into a local; hoist invariants and cache array `length` out of loops
- `unchecked {++i}` loop counters and `++i` over `i++`
- `constant`/`immutable` for never-reassigned values
- `public` → `external` where not called internally; `calldata` for read-only reference params
- `require(cond, "msg")` → custom error
- drop redundant zero-initialization (`uint x = 0;` → `uint x;`)

Do NOT repack structs, resize field types, change storage slots, or write inline assembly at
Level 1 — those belong to Level 2, behind the gate.

## The verification gate (Level 2)

Level 2 changes storage layout and may use assembly, which silently breaks on edge cases (dirty
bits, overflow, signed values, bounds) and is deployed without a human reading it. So at Level 2,
EVERY transform must pass this gate or be discarded:

1. **Behavior**: the contract's existing unit-test suite passes against the optimized version,
   unchanged. The tests are the spec. If the user's tests are thin, the safety guarantee is
   thin — say so explicitly.
2. **Gas**: `forge snapshot` (or a per-function gas report) shows the optimized version costs
   LESS. A transform that compiles and passes tests but does not measurably reduce gas is
   discarded — it only adds audit surface for no benefit.

Apply transforms one at a time and re-run the gate after each. Keep a transform only if both
conditions hold. This per-transform loop is what makes the output trustworthy.

**Level 2에서는 `gas snapshot 통과 + 테스트 통과`가 동시에 만족될 때만 변경을 채택한다. 둘 중 하나라도 실패하면 롤백한다.**

### When unit tests are not enough

Two conditions make "tests pass" a weak guarantee, and should trigger a recommendation that
the user enable fuzz / differential testing:

- The transform removes a runtime check the compiler inserted (bounds, overflow) — calldata
  direct reads, field downsizing.
- The transform touches signed values packed into a word (`int24`, `int128`) — sign bit handling
  (`sar` vs `shr`, `signextend`) is the classic silent bug, and typical unit tests don't probe
  negative boundary values.

For Level 2, fuzz is effectively required because external-behavior equivalence under a storage
redesign is hard to pin down with example-based tests alone. Offer to generate a differential
fuzz harness: deploy original and optimized side by side, fuzz every external function, assert
equal return values / state / events.

## Workflow — Level 1 (default, fast)

1. **Read the target contracts** under `src/` and note their external interface (it must be
   preserved). No test suite is required at Level 1 — the staple transforms don't remove checks.

2. **Apply the Level 1 staple transforms in a single pass**, only where they clearly fit (see the
   list above). A handful of well-chosen edits is enough; do not over-optimize and do not write
   assembly. **Do NOT run forge** (`build`/`test`/`snapshot`/fuzz) and do NOT iterate — Level 1 is
   meant to be fast and cheap.

3. **Write the optimized variants** into the output directory (mirroring the source layout; never
   edit the originals), then write a short `OPTIMIZATION_REPORT.md` listing what changed and why.

## Workflow — Level 2 (opt-in, verified)

1. **Read the target contract.** Identify the external interface (functions, events, view
   returns) — this must be preserved. Locate the existing test suite. If there is no test suite,
   stop and tell the user: without tests there is no verification gate, so a Level 2 (storage
   redesign / assembly) output cannot be trusted. Offer to help write tests first, or fall back
   to Level 1.

2. **Confirm scope.** Confirm new-deployment (this skill does not do proxy storage-collision
   analysis) and the output directory.

3. **Find candidate hotspots, ranked by expected payoff.** Do not apply assembly everywhere —
   the compiler already optimizes simple operations well, and blanket assembly adds risk for no
   gain. Prioritize:
   - storage reads/writes, especially fields written together that could share a slot (biggest
     lever — a saved cold SSTORE is ~20,000 gas)
   - loops and repeated operations
   - string/bytes construction, custom calldata decoding, batch operations (allocation/encoding
     overhead the optimizer can't remove)
   - frequently-called hot paths
   Deprioritize one-shot simple expressions where measured savings will be within noise.

4. **Match each hotspot to a pattern** from `references/pattern-corpus.md`. Use the corpus's
   before/after, rationale, safety conditions, and level tag. Do not invent novel assembly when
   a corpus pattern fits — the corpus patterns are extracted from audited production code.

5. **Apply one transform, run the gate, keep or revert.** Repeat. After each kept transform,
   the optimized file should still compile, pass tests, and show lower gas.

6. **Report.** For each applied transform: which pattern, the measured gas delta (from the
   snapshot), and any safety caveat (especially removed checks or signed-field handling). Flag
   anything that warrants the fuzz opt-in. Present the optimized contract in its own directory
   and the gas comparison.

## Using the pattern corpus

`references/pattern-corpus.md` is the knowledge base — read it when selecting transforms. It is
organized in three parts and ~25 categories (A–Y). Quick index:

**Part 1 — Solady (function-body techniques, mostly L1)**
- A: custom-error 4-byte revert · B: ETH send / low-level call / ERC20 dirty-return
- C: keccak256 in scratch space, mapping slot derivation · D: fixed-point math + bit ops
- E: direct calldata reads (removes bounds check — fuzz) · F: storage packing / bitmap (L2)
- G: log3/log4 event emit · H: transient-storage reentrancy guard (Cancun+)
- I: safe-cast with range check · J: delegatecall multicall · K: uint→string · L: data structures (L2)

**Part 2 — Uniswap V3/V4 (storage packing, mostly L2)**
- M: V3 struct packing — pack fields *mutated together* into one slot (the main lever)
- N: V4 user-defined value types — `type X is bytes32` + masked accessors; signed fields are the
  silent-bug hotspot (`sar`, `signextend`) — fuzz required
- O: transient storage for per-tx state (Cancun+) · P: extsload batch storage read

**Part 3 — Cyfrin Solodit audit findings (source-level refactors, NO assembly, mostly L1)**
- Q: redundant storage access — cache repeated SLOADs, hoist out of loops, avoid write-then-reread, emit-before-SSTORE
- R: storage classification — constant/immutable; `uint256(1)/(2)` flag (pre-Cancun fallback for H/O)
- S: calldata over memory for read-only params; drop unused params / forward calldata
- T: visibility/modifiers — public→external; payable on access-restricted functions
- U: control-flow — reorder cheap checks before cold SLOADs; remove always-true conditions
- V: combine multiple external calls to one target · W: named return variables
- X: loops — cache array length + `unchecked {++i}`; `++i` over `i++`
- Y: arithmetic/init micro-opts — `unchecked` (fuzz), `!= 0`, `x = x + y`, no default-init

These Part 3 refactors are source-level (plain Solidity, no assembly) and lower-risk — apply the
high-value ones (Q, R1, V, U1) FIRST, then reach for Part 1/2 assembly only where a hot path still
dominates the gas report. They still go through the same verification gate.

The corpus ends with measured gas results and cross-cutting safety rules. The most important
takeaways encoded there:
- **Slot count is the first-order lever.** Packing five hot fields into one slot saved ~66% on a
  measured cold write. Struct-vs-UDVT is a smaller second-order choice — prefer plain struct
  packing (M) as the L2 default; reserve UDVT (N) for genuinely hot read paths, behind fuzz.
- **Never remove an overflow/bounds/underflow check to save gas** — that check is the semantics.
- **Selectors and magic constants are verbatim** — a wrong custom-error selector or De Bruijn
  constant compiles fine and is wrong at runtime.
- **`/// @solidity memory-safe-assembly` must stay valid** — blocks may only use scratch space
  (`0x00`–`0x3f`) or memory at/above the free pointer that they consume or restore.

## Environment notes

- `forge` is the expected toolchain (gas report, snapshot, tests, fuzz). If the project uses
  Hardhat, adapt the verification commands but keep the same gate.
- Transient-storage patterns (H, O) require Cancun+ (EIP-1153). Confirm the target chain
  supports it before applying — this is the main "partial EVM equivalence" hazard.
- Keep the optimized output in its own directory; never edit the original source in place.
