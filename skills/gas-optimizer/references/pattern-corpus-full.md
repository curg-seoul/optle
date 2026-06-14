# Solidity Gas Optimization Pattern Corpus

Extracted from Solady (`vectorized/solady`) and Solmate (`transmissions11/solmate`).
Each entry: technique / before (plain Solidity) / after (inline assembly) / rationale / safety conditions / level.

Levels:
- **L1** = function-body only. Storage layout and external interface unchanged.
- **L2** = storage structure redesign allowed. External interface (signatures, events, view returns) preserved. New-deployment only.

All inline assembly blocks below preserve external behavior. Every Solady `assembly` block is annotated `/// @solidity memory-safe-assembly` because it only touches scratch space (`0x00`-`0x3f`) or properly allocates memory; the optimizer relies on this annotation, so generated code MUST keep it valid.

---

## CATEGORY A: Reverting with custom errors

### A1. Revert with 4-byte custom error selector (L1)

**Before**
```solidity
if (amount > balance) revert InsufficientBalance();
```

**After**
```solidity
assembly {
    if gt(amount, balance) {
        mstore(0x00, 0xf4d678b8) // `InsufficientBalance()`
        revert(0x1c, 0x04)
    }
}
```

**Rationale**: The Solidity compiler builds the revert via memory expansion and ABI encoding. The assembly form stores the 4-byte selector at the end of the first scratch word and reverts exactly 4 bytes (`0x1c` = offset 28, `0x04` = length 4). No memory expansion, no encoding overhead.

**Selector derivation**: `bytes4(keccak256("InsufficientBalance()"))`. Must be computed correctly per error signature; a wrong selector silently changes the revert data.

**Safety**: Selector must match the declared error exactly, including argument types. For errors WITH arguments, the args must also be mstore'd after the selector and the revert length extended. Scratch space only - memory-safe.

---

## CATEGORY B: ETH / external calls

### B1. Low-level ETH send with no return buffer (L1)

**Before**
```solidity
(bool success, ) = to.call{value: amount}("");
if (!success) revert ETHTransferFailed();
```

**After**
```solidity
assembly {
    if iszero(call(gas(), to, amount, codesize(), 0x00, codesize(), 0x00)) {
        mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`
        revert(0x1c, 0x04)
    }
}
```

**Rationale**: `codesize()` is used as both the input and output pointer/length args because we send no calldata and want no return data copied. `codesize()` is a cheap non-zero value that avoids allocating a real memory region. Skips the empty-bytes memory allocation the Solidity form emits.

**Safety**: Forwards all gas (`gas()`). For untrusted recipients this is a reentrancy/DoS surface - same as the Solidity equivalent, not worse. Use gas-stipend variants for DoS protection.

### B2. ERC20 transfer/transferFrom with dirty-return tolerance (L1)

ERC20 tokens that return nothing (USDT) vs. return bool must both be handled. Solady packs the calldata in scratch + free memory and checks `returndatasize()`.

**After (transfer)**
```solidity
assembly {
    mstore(0x14, to)    // store `to` at 0x14 (right-aligned address)
    mstore(0x34, amount)
    mstore(0x00, 0xa9059cbb000000000000000000000000) // `transfer(address,uint256)` selector + padding
    // call; success requires (no return data) OR (return data is non-zero / truthy)
    let success := call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
    if iszero(and(eq(mload(0x00), 1), success)) {
        // fallback: account for tokens that return nothing
        if iszero(lt(or(iszero(extcodesize(token)), returndatasize()), success)) { ... }
    }
    mstore(0x34, 0) // restore the zero slot (0x34 overlaps the free memory ptr region)
}
```

**Rationale**: Builds calldata directly in memory (`0x10`-`0x53`) without ABI encoder. The selector is left-packed into one word. Critically: `0x34` overlaps the slot just above the free memory pointer; Solady writes it then **restores it to 0** so the FMP region stays clean. This is the key memory-safety discipline.

**Safety**: MUST restore `mstore(0x34, 0)` (or equivalent) before leaving assembly, otherwise the free memory pointer's neighbor is corrupted. This is why these blocks are still `memory-safe-assembly` - they leave memory as they found it. An agent applying this pattern must never omit the restore.

---

## CATEGORY C: Hashing

### C1. keccak256 of two words via scratch space (L1)

**Before**
```solidity
bytes32 h = keccak256(abi.encode(a, b));
```

**After**
```solidity
assembly {
    mstore(0x00, a)
    mstore(0x20, b)
    h := keccak256(0x00, 0x40)
}
```

**Rationale**: `abi.encode` allocates fresh memory and copies. For a fixed small number of 32-byte words, the two scratch slots (`0x00`-`0x3f`) hold the operands and `keccak256` hashes them in place. Zero allocation.

**Safety**: Only valid when each operand is exactly one 32-byte word (`bytes32`, `uint256`, `address` cleaned). For `abi.encodePacked` semantics (tight packing) this is NOT equivalent - encode vs encodePacked differ. Must match the original hashing scheme exactly. Scratch-space only.

### C2. Storage slot for `mapping(address => uint256)` (L1)

**Before** (implicit in `balanceOf[user]`)

**After**
```solidity
assembly {
    mstore(0x0c, _BALANCE_SLOT_SEED) // a constant seed (e.g. 0x87a211a2...)
    mstore(0x00, user)
    let slot := keccak256(0x0c, 0x20)
}
```

**Rationale**: Solady replaces the default `mapping` slot derivation (`keccak256(key . slot)`) with a custom seed packed next to the key so the hash preimage is one 32-byte region starting at `0x0c`. This is a layout choice that lets multiple related mappings (balance, allowance, nonces) share derivation logic cheaply.

**Safety**: This DEFINES a custom storage layout - it is L2 if applied to a contract that didn't already use this scheme, because the slot of `balanceOf[user]` changes. In Solady's own ERC20 the seed IS the layout, so it's self-consistent. An agent must not mix Solidity-default mapping access and seed-based access for the same mapping.

---

## CATEGORY D: Bit / math operations

### D1. mulWad (fixed-point multiply with overflow check) (L1)

**After**
```solidity
assembly {
    if gt(x, div(not(0), y)) {
        if y {
            mstore(0x00, 0xbac65e5b) // `MulWadFailed()`
            revert(0x1c, 0x04)
        }
    }
    z := div(mul(x, y), WAD)
}
```

**Rationale**: Overflow check `x <= type(uint256).max / y` expressed as `gt(x, div(not(0), y))` where `not(0)` is `type(uint256).max`. The nested `if y` handles the `y == 0` case (no overflow possible) without a separate branch cost in the common path.

**Safety**: Replicates checked-math semantics manually. The overflow guard MUST be present; removing it to "save gas" reintroduces overflow. This is the boundary where gas optimization meets correctness - the check is the point.

### D2. fls / msb / clz (find-last-set bit) (L1)

**After** (see `LibBit.fls`): a sequence of `or(r, shl(k, lt(threshold, shr(r, x))))` doing binary search over bit position, finished by a De Bruijn-style lookup `byte(..., 0x070606...)`.

**Rationale**: Replaces a loop or lookup table with branchless binary search + a single packed lookup constant. No loop, no SLOAD, fully `pure`. The magic constant encodes a De Bruijn sequence mapping isolated bits to positions.

**Safety**: Pure arithmetic on the input. The magic constants are exact and must be copied verbatim - they are not derivable at runtime. Do not "simplify".

---

## CATEGORY E: Memory and calldata

### E1. Reading calldata directly (L1)

**Before**
```solidity
function f(uint256[] calldata a) external {
    uint256 first = a[0];
}
```

**After**
```solidity
assembly {
    let first := calldataload(a.offset)
}
```

**Rationale**: `a[0]` in Solidity inserts a bounds check and offset computation. When the access is provably in-range (or the caller guarantees it), `calldataload(a.offset)` reads the word directly.

**Safety**: REMOVES the bounds check. Only safe when length is independently validated or invariant. This is a place where "tests pass" can hide an out-of-bounds read that returns garbage instead of reverting. Flag for fuzz opt-in.

---

## CATEGORY F: Storage packing (L2 only)

### F1. Multiple small values in one slot via bitmap (L2)

From `LibMap.Uint8Map` - storing `uint8` values packed 32-per-slot.

**get**
```solidity
assembly {
    mstore(0x20, map.slot)
    mstore(0x00, shr(5, index))            // slot index = index / 32
    result := byte(and(31, not(index)), sload(keccak256(0x00, 0x40)))
}
```

**Rationale**: 32 `uint8` values share one 256-bit slot. `shr(5, index)` selects which slot, `and(31, not(index))` selects the byte within it. One SLOAD serves 32 logical entries; sequential writes to nearby indices hit a warm slot.

**Safety (L2)**: This changes storage layout entirely. Only valid for new deployments (storage collision on upgrade). The external getter/setter signatures stay the same, so unit tests on the interface still apply - but tests that assert specific storage slots will break and that is expected, not a bug. External behavior equivalence here is weakly covered by interface unit tests; fuzz over index ranges is strongly recommended.

### F2. Struct field packing (L2)

Reorder/resize struct fields so they pack into fewer 32-byte slots (e.g. `uint128 a; uint128 b;` in one slot instead of two `uint256`).

**Rationale**: Each saved slot saves a cold SLOAD (2100 gas) / SSTORE (up to 20000 gas on zero->nonzero). Packing related fields written together amortizes to a single SSTORE.

**Safety (L2)**: Field downsizing (`uint256` -> `uint128`) must be proven safe against the value ranges the contract actually uses, or it silently truncates. This is the highest-risk transform in the corpus - unit tests rarely exercise boundary values. Require fuzz opt-in before applying.

---

## CROSS-CUTTING SAFETY RULES (for the agent)

1. **Always keep `/// @solidity memory-safe-assembly`** and ensure the block actually is: only scratch space (`0x00`-`0x3f`), or memory above the free memory pointer that is either consumed or restored. If a block writes near the FMP, it must restore it.
2. **Never drop an overflow/underflow/bounds check to save gas.** Those checks ARE the semantics. Removing them is the most common way "tests still pass" produces an exploitable contract.
3. **Selectors and magic constants are verbatim.** A wrong custom-error selector or De Bruijn constant compiles fine and is wrong at runtime.
4. **L1 must not change storage slot derivation.** If a transform changes where a mapping/variable lives, it is L2.
5. **L2 is new-deployment only.** Storage layout changes collide on upgradeable proxies.
6. **Each transform is independently revertible.** Apply one, run tests + gas snapshot, keep only if tests pass AND gas decreased.
7. **Weak coverage => recommend fuzz.** Calldata bounds removal (E1), field downsizing (F2), and any L2 transform have behavior not fully pinned by typical unit tests.

---

## CATEGORY G: Event emission

### G1. Emit indexed event via log3/log4 (L1)

**Before**
```solidity
emit Transfer(from, to, amount);
```

**After**
```solidity
assembly {
    mstore(0x20, amount)
    // log3(dataPtr, dataLen, topic0, topic1, topic2)
    log3(0x20, 0x20, _TRANSFER_EVENT_SIGNATURE, from, to)
}
```

**Rationale**: `_TRANSFER_EVENT_SIGNATURE` is the precomputed `keccak256("Transfer(address,address,uint256)")` as a constant. The Solidity `emit` recomputes/loads topic and lays out non-indexed data via the encoder. The assembly form puts the single non-indexed word (`amount`) in scratch and emits directly. Indexed args become topics, non-indexed become data.

**Safety**: Topic0 constant must be the exact event signature hash. Indexed address topics must be cleaned to 160 bits (Solady often does this via `shr(96, shl(96, x))` or by reading back a masked store). Scratch space only.

---

## CATEGORY H: Transient storage (EIP-1153)

### H1. Reentrancy guard with tstore/tload (L1, post-Cancun)

**Before** (storage-based guard: SLOAD+SSTORE, cold 2100+ / 20000 gas)
```solidity
modifier nonReentrant() {
    require(_status != _ENTERED);
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
}
```

**After**
```solidity
assembly {
    if tload(_REENTRANCY_GUARD_SLOT) {
        mstore(0x00, 0xab143c06) // `Reentrancy()`
        revert(0x1c, 0x04)
    }
    tstore(_REENTRANCY_GUARD_SLOT, address())
}
// ... after body:
assembly { tstore(_REENTRANCY_GUARD_SLOT, 0) }
```

**Rationale**: `TSTORE`/`TLOAD` cost 100 gas and auto-clear at end of transaction. Replaces a cold SSTORE (up to 20000) + refund dance with two 100-gas ops. Storing `address()` rather than a flag also disambiguates cross-contract.

**Safety**: Requires Cancun+ (EIP-1153). NOT available on chains without transient storage - this is the `partial EVM equivalence` caveat. The agent must confirm target chain support before applying. Guard slot is a fixed constant.

---

## CATEGORY I: Safe casting

### I1. Downcast with overflow revert (L1)

**After**
```solidity
function toUint8(uint256 x) internal pure returns (uint8) {
    if (x >= 1 << 8) _revertOverflow();
    return uint8(x);
}
```

**Rationale**: Solady keeps the range check in plain Solidity (cheap comparison) and centralizes the revert in one `_revertOverflow()` assembly helper to minimize bytecode duplication across many cast functions. The lesson: not every optimization is "more assembly" - sometimes it's deduplicating the revert path.

**Safety**: The `x >= 1 << 8` bound must match the target type width exactly. This check is the correctness guarantee for L2 field-downsizing transforms (F2) - reuse it rather than removing the check.

---

## CATEGORY J: Batch / multicall

### J1. delegatecall loop over calldata array (L1)

From `Multicallable`:
```solidity
assembly {
    calldatacopy(c, data.offset, end)
    // for each sub-call:
    calldatacopy(m, add(o, 0x20), calldataload(o))
    if iszero(delegatecall(gas(), address(), m, calldataload(o), codesize(), 0x00)) {
        returndatacopy(results, 0x00, returndatasize())
        revert(results, returndatasize())   // bubble up revert
    }
    returndatacopy(b, 0x00, returndatasize())
}
```

**Rationale**: Aggregates N calls into one transaction. Copies each sub-calldata into memory, `delegatecall`s self (preserving `msg.sender`/storage context), and either bubbles the revert verbatim (`returndatacopy` + `revert`) or appends the return data. Avoids per-call ABI encode/decode overhead.

**Safety**: `delegatecall(address())` runs in the contract's own context - safe for self-batching, dangerous if the target were attacker-controlled (it isn't here). Revert bubbling preserves the original error data. Memory regions are explicitly managed; verify FMP is advanced past written regions.

---

## CATEGORY K: String / bytes construction

### K1. uint256 -> decimal string, write right-to-left (L1)

From `LibString.toString`:
```solidity
assembly {
    result := add(mload(0x40), 0x80)   // allocate with headroom
    mstore(0x40, add(result, 0x20))
    let end := result
    let w := not(0)                    // -1, used as sub(_,1)
    for { let temp := value } 1 {} {
        result := add(result, w)
        mstore8(result, add(48, mod(temp, 10)))  // ASCII digit
        temp := div(temp, 10)
        if iszero(temp) { break }
    }
    let n := sub(end, result)
    result := sub(result, 0x20)
    mstore(result, n)                  // write length prefix
}
```

**Rationale**: Builds the digit string in place by writing the least-significant digit first into pre-allocated memory, then back-filling the length word. `w := not(0)` is `-1` reused as a cheap decrement. No per-digit allocation, no recursion. The `do-while` (`for {..} 1 {}`) shape handles `value == 0` correctly.

**Safety**: Proper memory allocation (advances FMP) - this block ALLOCATES, unlike scratch-only blocks, but does so correctly so it stays `memory-safe-assembly`. Headroom (`0x80`) prevents the length write from clobbering. An agent must preserve the allocation arithmetic exactly.

---

## CATEGORY L: Data structures (L2)

### L1. EnumerableSet / MinHeap / RedBlackTree (L2)

These libraries implement set/heap/tree semantics directly over storage slots with assembly slot derivation. They are drop-in replacements for naive `mapping` + array bookkeeping.

**Rationale**: A naive "set" using `mapping(x=>bool) present` + `x[] values` + manual index tracking does multiple cold SSTOREs per op. Solady's `EnumerableSetLib` packs the index map and value array slot derivation to minimize SSTOREs, and inlines membership checks.

**Safety (L2)**: Choosing one of these as a replacement for a hand-rolled structure changes storage layout entirely (new-deployment only) and external behavior equivalence depends on matching the original semantics (ordering guarantees, duplicate handling). Interface unit tests cover the happy path; fuzz over insert/remove/iterate sequences is strongly recommended before trusting the swap.

---

## EXTRACTION NOTE

Solady contains 570+ assembly blocks across 100+ files. This corpus captures the DISTINCT, transferable techniques rather than every instance. Files like `LibClone` (proxy bytecode assembly), `ERC1967Factory`, `CREATE3`, `SSTORE2` are codegen/deployment-specific: their techniques (raw init-code construction, `create2` salt handling, storing data as contract code) are powerful but apply to narrow use-cases, not general function-body optimization. They are referenced here as L2/specialized but should not be auto-applied by the agent to arbitrary business logic.

---

## MEASURED RESULTS (forge 1.5.1, solc 0.8.28, optimizer_runs=200)

Function-level gas (isolated calls, via `--gas-report` avg):

| Technique | Naive | Assembly | Delta |
|-----------|-------|----------|-------|
| C1 keccak256(2 words) | 435 | 431 | ~1% (negligible) |
| A1 custom error revert | 293 | 271 | ~7.5% |
| K1 uint->decimal string | 15634 (avg) | 2245 (avg) | ~85% |

Fuzz equivalence (256 runs each) passed for hash and toString naive-vs-asm pairs.

**Key lesson for the agent**: gas savings are HIGHLY uneven.
- Simple operations the Solidity optimizer already handles well (single keccak of two words, a bare revert) yield near-zero savings. Applying assembly there adds risk for no benefit.
- Big wins come from operations with allocation/loop/encoding overhead the optimizer cannot eliminate: string/bytes construction, batch operations, packed storage, custom calldata decoding.

The agent should PRIORITIZE transforms by expected payoff and SKIP transforms whose measured delta is within noise. A transform that does not measurably reduce gas must be discarded even if it compiles and passes tests - it only adds audit surface. This is why the gas-snapshot gate is mandatory, not advisory.

---

# PART 2: UNISWAP V3 / V4 PATTERNS

Extracted from `Uniswap/v3-core` and `Uniswap/v4-core`. Uniswap's optimizations center on STRUCT PACKING and (in V4) replacing packed structs with user-defined value types manipulated by bit operations, plus full transient-storage adoption.

## CATEGORY M: Struct packing (Uniswap V3) (L2)

### M1. Slot0 - hot state in a single slot (L2)

V3 `UniswapV3Pool.Slot0` packs 7 fields into ONE 256-bit slot (248 bits used):
```solidity
struct Slot0 {
    uint160 sqrtPriceX96;          // 160
    int24 tick;                    //  24
    uint16 observationIndex;       //  16
    uint16 observationCardinality; //  16
    uint16 observationCardinalityNext; // 16
    uint8 feeProtocol;             //   8
    bool unlocked;                 //   8
}  // total 248 bits -> 1 slot
```

**Rationale**: This is the single most-read/written piece of state in a swap. Packing into one slot means a swap touches ONE storage slot for all of it: one cold SLOAD (2100) on first access then warm (100), and writes coalesce into one SSTORE instead of up to seven. The field order is deliberate - `sqrtPriceX96` (160) + `tick` (24) + small fields fill the slot with no field straddling the 256-bit boundary.

**Safety (L2)**: Field widths must hold the real value ranges (`tick` as `int24` covers Uniswap's tick range; `sqrtPriceX96` fits in 160 by construction of Q64.96). Packing only helps when the fields are read/written TOGETHER - packing fields touched in unrelated code paths can ADD masking cost without saving SLOADs. New-deployment layout decision.

### M2. Co-locating fields updated together (L2)

V3 `Tick.Info`: `liquidityGross` (uint128) + `liquidityNet` (int128) are the first two fields = one slot, and both are updated on every tick cross. `Position.Info`: `tokensOwed0` (uint128) + `tokensOwed1` (uint128) packed into one slot, both updated on fee collection.

**Rationale**: The packing target is not "smallest total size" but "fields mutated in the same operation share a slot". A tick cross writes liquidityGross+liquidityNet in one SSTORE. The `bool initialized` in Tick.Info is explicitly documented as occupying 8 bits "to prevent fresh sstores when crossing newly initialized ticks" - keeping the slot non-zero avoids the 20000-gas zero->nonzero penalty being paid repeatedly.

**Safety (L2)**: Requires understanding the access pattern, not just the type sizes. An agent doing L2 packing must group by co-mutation, which means it needs the call-graph, not just the struct definition. Flag this as needing the optimizer to analyze WHICH fields change together.

## CATEGORY N: User-defined value types + bit manipulation (Uniswap V4) (L2)

### N1. Slot0 as `type ... is bytes32` with masked accessors (L2)

V4 replaces the V3 struct with `type Slot0 is bytes32` and reads/writes fields by shift+mask:
```solidity
// layout: 24 empty | 24 lpFee | 12 protocolFee(1->0) | 12 protocolFee(0->1) | 24 tick | 160 sqrtPriceX96

function sqrtPriceX96(Slot0 _packed) internal pure returns (uint160 r) {
    assembly ("memory-safe") { r := and(MASK_160_BITS, _packed) }
}
function tick(Slot0 _packed) internal pure returns (int24 r) {
    assembly ("memory-safe") { r := signextend(2, shr(TICK_OFFSET, _packed)) } // TICK_OFFSET=160
}
function setTick(Slot0 _packed, int24 _tick) internal pure returns (Slot0 r) {
    assembly ("memory-safe") {
        r := or(and(not(shl(TICK_OFFSET, MASK_24_BITS)), _packed), shl(TICK_OFFSET, and(MASK_24_BITS, _tick)))
    }
}
```

**Rationale**: A Solidity struct, even when packed into one slot, still gets unpacked into separate memory words when loaded into a memory/stack variable. The UDVT keeps the value as a single `bytes32` the whole time - no memory expansion, fields extracted on demand by masking. `signextend(2, ...)` recovers the signed `int24` (2 = bytes-1). `setTick` clears the field region (`and(not(shl(offset, mask)), packed)`) then ORs in the new value.

**Safety (L2)**: Sign handling is the trap. Signed fields need `signextend` on read and masking to the field width on write (`and(MASK_24_BITS, _tick)`), otherwise negative values corrupt neighbors. The masks and offsets must match the documented layout exactly. This is strictly more error-prone than M1 struct packing - recommend fuzz over the full field-value range.

### N2. Two signed int128 in one word - BalanceDelta (L2)

```solidity
function toBalanceDelta(int128 _amount0, int128 _amount1) pure returns (BalanceDelta d) {
    assembly ("memory-safe") {
        d := or(shl(128, _amount0), and(sub(shl(128, 1), 1), _amount1))
    }
}
// extraction with sign preservation:
//   a0 := sar(128, a)        // arithmetic shift right keeps sign of high half
//   a1 := signextend(15, a)  // sign-extend low 16 bytes for low half
```

**Rationale**: Packs two signed 128-bit deltas into one `bytes32`, returned/passed as a single value. `sar` (arithmetic, not logical `shr`) preserves the sign bit when extracting the high field; `signextend(15, ...)` sign-extends the low field (15 = bytes-1 for 16 bytes). Arithmetic on packed deltas (`add`/`sub`) is done per-half then re-packed with overflow checks via `toInt128()`.

**Safety (L2)**: The `shr` vs `sar` distinction is a silent correctness bug if wrong - `shr` would zero-fill and turn negative numbers positive. Re-packing must re-check each half fits in int128 (Uniswap uses `SafeCast.toInt128`). This is the canonical example of "tests pass but a negative-value input is mishandled" - fuzz with negative inputs is essential.

## CATEGORY O: Transient storage everywhere (Uniswap V4) (L1/L2)

### O1. Boolean lock via tstore/tload (L1)

```solidity
library Lock {
    bytes32 internal constant IS_UNLOCKED_SLOT = 0xc090...ab23;
    function unlock() internal { assembly ("memory-safe") { tstore(IS_UNLOCKED_SLOT, true) } }
    function lock()   internal { assembly ("memory-safe") { tstore(IS_UNLOCKED_SLOT, false) } }
    function isUnlocked() internal view returns (bool u) {
        assembly ("memory-safe") { u := tload(IS_UNLOCKED_SLOT) }
    }
}
```

**Rationale**: V4's "flash accounting" keeps the lock and the running token deltas in transient storage (`NonzeroDeltaCount`, `CurrencyReserves` use the same pattern). Within one transaction these are written/read many times; at 100 gas each vs SSTORE's cold/warm pricing and the 20000-gas zero->nonzero, transient storage is dramatically cheaper and needs no end-of-call cleanup SSTORE (auto-cleared).

**Safety**: Cancun+ only (EIP-1153), same caveat as Solady H1. The fixed slot constant is a hashed namespace to avoid collision. Auto-clear semantics mean you must not rely on transient values persisting across transactions.

## CATEGORY P: Batch storage read for off-chain (Uniswap V4) (L1)

### P1. extsload - read N arbitrary slots in one call (L1)

```solidity
function extsload(bytes32 startSlot, uint256 nSlots) external view returns (bytes32[] memory) {
    assembly ("memory-safe") {
        let memptr := mload(0x40)
        let start := memptr
        let length := shl(5, nSlots)          // nSlots * 32, shift cheaper than mul
        mstore(memptr, 0x20)                  // abi offset of dynamic array
        mstore(add(memptr, 0x20), nSlots)     // array length
        memptr := add(memptr, 0x40)
        let end := add(memptr, length)
        for {} 1 {} {
            mstore(memptr, sload(startSlot))
            memptr := add(memptr, 0x20)
            startSlot := add(startSlot, 1)
            if iszero(lt(memptr, end)) { break }
        }
        return(start, sub(end, start))
    }
}
```

**Rationale**: Exposes raw storage to off-chain readers without per-field getters, building the entire ABI-encoded `bytes32[]` return in memory by hand and `return`ing it directly - no Solidity array allocation/copy. `shl(5, n)` = `n*32`. This is a read-side optimization for indexers/integrators; it does not change on-chain write costs.

**Safety**: `return` inside assembly exits the whole function with hand-built returndata - the layout (offset word, length word, then elements) must exactly match the declared `bytes32[] memory` ABI or decoders break. Memory-safe because it only uses memory from the FMP onward and returns before any further allocation.

---

## UNISWAP-SPECIFIC LESSONS FOR THE AGENT

1. **Packing target = co-mutation, not minimal size (M2).** The win is grouping fields written in the same operation into one slot so one SSTORE covers them. This requires call-graph awareness, not just reading the struct. An L2 packer that only looks at type widths will miss the real optimization and may even add masking cost.

2. **Keeping a slot non-zero avoids repeated zero->nonzero SSTORE (20000 gas) (M2, `Tick.initialized`).** A deliberate "always set" bit can be cheaper than letting a slot return to zero and be re-initialized.

3. **UDVT > packed struct for hot values (N1).** A packed Solidity struct still unpacks into memory when loaded; a `type X is bytes32` stays one word and extracts fields by masking on demand. This is V4's main advance over V3, and the highest-skill transform - signed fields (`signextend`, `sar`) are where it breaks silently.

4. **`shr` vs `sar`, and field-width masking on write, are the silent-bug hotspots (N1, N2).** Negative values are the failure mode that unit tests usually miss. Any signed-field packing transform MUST trigger the fuzz opt-in.

5. **Transient storage for per-transaction state (O1)** is a near-universal win post-Cancun for locks, counters, and running tallies - but is the prime "partial EVM equivalence" hazard. Confirm chain support.

---

## MEASURED RESULTS - PACKING (forge 1.5.1, solc 0.8.28, optimizer_runs=200)

Cold write of 5 hot-state fields (zero->nonzero), Slot0-style layout:

| Layout | Slots | Gas (cold write) | vs Unpacked |
|--------|-------|------------------|-------------|
| Unpacked (5x uint256) | 5 | 133,252 | baseline |
| V3 packed struct | 1 | 45,153 | -66% |
| V4 UDVT (bytes32 + masks) | 1 | 44,474 | -66.6% |

Fuzz equivalence for the V4 UDVT pack/unpack (256 runs, including negative `int24 tick`) passed.

**Reading the numbers**:
- The dominant saving is going from 5 slots to 1: four fewer cold SSTOREs at ~20,000 gas each ~= ~80,000 gas. That is the struct-packing win, and it is enormous on cold writes.
- V4 UDVT beats V3 struct only marginally on this storage-write benchmark (44,474 vs 45,153). The UDVT advantage shows up more in HOT paths where the value is loaded into memory and fields are read repeatedly without re-expanding a struct into separate memory words - not fully captured by a single cold-write microbenchmark.
- Takeaway for the agent: the first-order lever is SLOT COUNT (pack co-mutated fields). The struct-vs-UDVT choice is a smaller second-order optimization that costs significant added complexity and signed-field risk. Recommend struct packing (M1/M2) as the default L2 move and reserve UDVT (N1/N2) for genuinely hot read paths, gated behind fuzz.

---

## CASE STUDY: L2 storage packing on a vesting contract (measured)

Applied to a common multi-beneficiary linear-vesting `VestingSchedule` struct that stored every
field as its own 256-bit slot (9 slots). Repacked into 3 slots: `address+uint48 start+uint48 cliff`
(slot 0), `uint48 duration+uint48 slice+3 bools+uint128 amountTotal` (slot 1), `uint128 released`
(slot 2).

**Measured (forge 1.5.1, solc 0.8.28, optimizer_runs=200)**

| Function | Original | Optimized | Delta |
|----------|----------|-----------|-------|
| createVestingSchedule (cold write) | 249,907 | 137,454 | -45% (~112k gas) |
| computeReleasableAmount (cold read) | 14,061 | 8,136 | -42% |

Six fewer cold SSTOREs (6 x ~20k) accounts for the bulk of the create saving.

**Interface-preservation technique**: `getSchedule` returns a `VestingSchedule memory` whose
field types are part of the external ABI. The optimization keeps that public struct shape with
`uint256` fields UNCHANGED, and introduces a SEPARATE internal `Packed` struct. The getter widens
packed fields back to `uint256`. Lesson: when a packed type is exposed through a return value or
event, keep the external type and pack only the internal storage representation - do not change
the ABI.

**The bug the differential fuzz caught (critical)**: The original stores `cliff = start + _cliff`
as a `uint256`. The packed version downcasts it to `uint48`. Fuzzing found `start ~= 2^48`,
`cliff = 22`: the sum exceeds `uint48` max, so the optimized contract reverted `DowncastOverflow`
on an input the original accepted - a behavior divergence, NOT caught by the example unit tests.

Resolution: packing assumes timestamps (and any stored SUM of them) fit in `uint48`. That is a
real invariant for new deployments (uint48 seconds ~= 8.9 million years), but it must be made
explicit, and the differential fuzz must be bounded to that invariant - otherwise the two
contracts are genuinely not equivalent at the boundary. This is the canonical example of why:
- field downsizing REQUIRES fuzz, not just unit tests (rule 7 / E1 / F2),
- a stored derived value (`start + cliff`) needs its OWN range check, not just the input fields',
- "tests pass" is meaningless if the tests never probe the downcast boundary.

---

# PART 3: AUDIT-FINDING PATTERNS (Cyfrin Solodit)

Extracted from gas-impact findings on Cyfrin Solodit (`https://solodit.cyfrin.io`, Impact = Gas): recent
comprehensive Cyfrin audits (storage / calldata / control-flow refactors, largely by Dacian) plus the
recurring "G-xx" catalog confirmed across dozens of contests (Code4rena, Sherlock, ...).

Unlike Parts 1-2, these are **source-level refactors - plain Solidity, no inline assembly**. They cut gas
by removing redundant work the optimizer cannot eliminate (extra SLOADs, copies, checks, external calls)
or by reclassifying state. Most are L1 (function-body only); a few touch storage classification and are
tagged accordingly. Every one still goes through the same verification gate (tests + `forge snapshot`).

These compose with Parts 1-2: do the structural refactors here FIRST (they are lower-risk and often the
bigger lever), then reach for assembly (Parts 1-2) only where a hot path still dominates the gas report.

Duplicates already covered are intentionally omitted: custom-error reverts (A1), low-level ETH send (B1),
struct/slot packing (F2, M1-M2). The entries below are the techniques NOT already in Parts 1-2.

## CATEGORY Q: Redundant storage access (L1)

### Q1. Cache a storage slot read multiple times; hoist invariant reads out of loops (L1)

**Before**
```solidity
if (config.limit == 0) revert();
uint256 x = config.limit * 2;     // 2nd SLOAD of the same slot
emit Used(config.limit);          // 3rd SLOAD
```

**After**
```solidity
uint256 limit = config.limit;     // single SLOAD
if (limit == 0) revert();
uint256 x = limit * 2;
emit Used(limit);
```
In loops, hoist invariant reads above the loop and copy storage-pointer struct fields into locals once
per iteration:
```solidity
address _owner = owner;                                   // hoisted out of loop
for (uint256 i; i < n; ++i) { if (list[i] == _owner) { /* ... */ } }
```

**Rationale**: a repeated warm SLOAD is ~100 gas, a cold one ~2100. Once a slot is read or written and
cannot change before the next access, re-reading is pure waste. In loops the redundancy multiplies by the
iteration count.

**Safety (L1)**: only cache a slot that cannot change between reads - no external call and no write to that
slot in between (a `delegatecall` or reentrant call can mutate it). Caching a slot read only once adds a
stack op for no benefit; cache only when read 2+ times.

Source: https://solodit.cyfrin.io/issues/cache-storage-slots-read-multiple-times-within-the-same-function-cyfrin-none-armada-crowdfund-governance-markdown

### Q2. Return computed values from helpers instead of write-then-reread (storage round-trips) (L1)

**Before**
```solidity
function _update() internal { maxObserved = _compute(); }
function release() external {
    _update();
    uint256 m = maxObserved;          // re-reads the slot just written
}
```

**After**
```solidity
function _update() internal returns (uint256 m) { m = _compute(); maxObserved = m; }
function release() external {
    uint256 m = _update();            // uses the returned local, no extra SLOAD
}
```

**Rationale**: a helper writes a slot, returns, and the caller immediately SLOADs the same slot. Returning
the just-computed value as a named return removes the round-trip; keep the state write if external readers
need it.

**Safety (L1)**: storage write is preserved, so external observers are unaffected; only the internal
re-read is removed. Verify the returned value equals the stored value on every path (including the
no-change path).

Source: https://solodit.cyfrin.io/issues/storage-round-trips-helpers-write-state-that-callers-immediately-re-read-instead-of-returning-the-value-cyfrin-none-armada-crowdfund-governance-markdown

### Q3. Emit the event before the SSTORE to drop the "old value" local (L1)

**Before**
```solidity
uint256 oldMax = maxObserved;     // local exists only to feed the event
maxObserved = capped;
emit Updated(oldMax, capped);
```

**After**
```solidity
emit Updated(maxObserved, capped);   // reads the still-current value directly
maxObserved = capped;
```

**Rationale**: code often reads a slot into `oldX` only to feed it into an event emitted AFTER the SSTORE.
Emitting before the overwrite reads the current value directly, removing the local and the stack slot held
across the SSTORE. The optimizer cannot do this itself - emits are observable side effects.

**Safety (L1)**: this changes the relative ORDER of this event versus other emits in the same function. If
off-chain indexers rely on event ordering, preserve it (leave the site as-is). The reported values are
unchanged.

Source: https://solodit.cyfrin.io/issues/reorder-emit-before-storage-write-to-eliminate-old-local-variables-cyfrin-none-armada-crowdfund-governance-markdown

## CATEGORY R: Storage classification (L1)

### R1. Mark never-changing values `constant` / `immutable` instead of storage (L1)

**Before**
```solidity
uint256 public rewardsDuration = 30 days;   // storage slot, SLOAD on every read
uint256 public deployTime;                   // set once in constructor, never changed
```

**After**
```solidity
uint256 public constant REWARDS_DURATION = 30 days;   // lives in bytecode
uint256 public immutable DEPLOY_TIME;                 // bytecode, assigned in constructor
```

**Rationale**: `constant` (compile-time known) and `immutable` (set once in the constructor) values are
embedded in the contract bytecode, so reads avoid the ~2100-gas SLOAD entirely.

**Safety (L1)**: only for values that are truly never reassigned after construction. Reads return the same
value, so the external interface is unchanged. (Use UPPER_CASE for constants by convention.)

Source: https://solodit.cyfrin.io/?i=GAS&s=immutable+constant  (e.g. Marginal, Inshallah Network)

### R2. `uint256(1)/uint256(2)` instead of `bool` for a frequently toggled flag (L1; pre-Cancun alternative to H1/O1)

**Before**
```solidity
bool private _entered;                 // false (0) <-> true (1) each guarded call
```

**After**
```solidity
uint256 private _status;               // 1 = not entered, 2 = entered (never 0)
```

**Rationale**: a storage slot that returns to zero and is set non-zero again repeatedly pays the
zero->non-zero SSTORE penalty each time. Keeping the slot always non-zero (1/2) avoids that. This is the
classic OpenZeppelin `ReentrancyGuard` representation.

**Safety (L1)**: behavior-equivalent for the flag's logic. On Cancun+ chains, the transient-storage guard
(H1 / O1) is cheaper still - prefer it when available; use this pattern as the pre-Cancun / portable
fallback. Only worth it for hot, frequently-flipped flags; do not apply blindly to every bool.

Source: https://solodit.cyfrin.io/?i=GAS&s=uint256+instead+of+true+false  (PoolTogether "[G-33]")

## CATEGORY S: Calldata & parameters (L1)

### S1. `calldata` instead of `memory` for external read-only reference params (L1)

**Before**
```solidity
function propose(address[] memory targets, bytes[] memory data, string memory desc) external { /* reads only */ }
```

**After**
```solidity
function propose(address[] calldata targets, bytes[] calldata data, string calldata desc) external { /* reads only */ }
```

**Rationale**: an `external` function that only READS a reference-type parameter should declare it
`calldata`. `memory` forces a full calldata->memory copy on entry; `calldata` reads in place. Savings scale
with the data size. (Distinct from E1: this is the data-location keyword, no assembly, and it KEEPS bounds
checks - E1 is the assembly form that removes them.)

**Safety (L1)**: only valid when the parameter is not mutated and the function is `external` (or `public`
used only externally). Constructors cannot take `calldata` reference types.

Source: https://solodit.cyfrin.io/issues/use-calldata-instead-of-memory-for-external-array-parameters-in-armadagovernorpropose-proposestewardspend-cyfrin-none-armada-crowdfund-governance-markdown

### S2. Drop unused locals/params; forward calldata directly instead of copying to memory (L1)

**Before**
```solidity
function _validate(Mode m, Op calldata op) internal {   // m unused
    Storage storage s = _store();        // unused
    Op memory copy = op;                 // never modified -> needless ABI re-encode
    validator.run(copy, hash);
}
```

**After**
```solidity
function _validate(Op calldata op) internal {           // dropped unused Mode m
    validator.run(op, hash);                             // forward calldata directly
}
```

**Rationale**: unused locals/params still cost stack/code, and copying a `calldata` struct into `memory`
only to pass it onward forces an extra ABI re-encode. If the callee accepts `calldata`, forward the
original reference.

**Safety (L1)**: removing a parameter changes the function signature - safe for `internal` functions and
their in-repo callers; if the function is external/public its selector changes, which is an interface
change (out of L1 scope unless the function is genuinely unused externally).

Source: https://solodit.cyfrin.io/issues/unused-locals-and-parameters-in-validationmanager_validateuserop-cyfrin-none-molecule-onchainlab-markdown

## CATEGORY T: Visibility & modifiers (L1)

### T1. Mark `public` functions never called internally as `external` (L1)

**Before**
```solidity
function getInfo(address u) public view returns (Info memory) { /* ... */ }
```

**After**
```solidity
function getInfo(address u) external view returns (Info memory) { /* ... */ }
```

**Rationale**: `external` reads arguments straight from calldata; `public` must also copy them to memory to
satisfy the internal-call ABI. A function never invoked from within the contract can be `external`.

**Safety (L1)**: keep `public` if the function is also called internally (an `external` function cannot be
called internally without `this.`). External callers are unaffected.

Source: https://solodit.cyfrin.io/issues/public-view-functions-that-are-never-called-internally-can-be-marked-external-cyfrin-none-wlfi-unlock-markdown

### T2. Mark access-restricted functions `payable` (L1)

**Before**
```solidity
function setFee(uint256 f) external onlyOwner { fee = f; }
```

**After**
```solidity
function setFee(uint256 f) external payable onlyOwner { fee = f; }
```

**Rationale**: an `onlyOwner`/`onlyRole` function reverts for normal callers anyway, so the compiler's
`msg.value == 0` guard is dead weight. `payable` removes it (CALLVALUE, DUP1, ISZERO, JUMPI, ...), ~21 gas
per call plus a small deployment saving.

**Safety (L1)**: only for access-restricted functions where a legitimate (authorized) caller will never
send ETH and the function has no path that mis-handles received ETH. Never apply to user-facing functions.

Source: https://solodit.cyfrin.io/?i=GAS&s=payable  (Wise Lending, Axelar, LooksRare)

## CATEGORY U: Control-flow ordering (L1)

### U1. Reorder cheap calldata/input checks before cold SLOADs (fail fast) (L1)

**Before**
```solidity
require(!windDownSet, "set");            // cold SLOAD paid even when the next check fails
require(addr != address(0), "zero");     // cheap calldata check, but too late
```

**After**
```solidity
require(msg.sender == DEPLOYER, "auth"); // immutable guard (cheap)
require(addr != address(0), "zero");     // cheap calldata check first
require(!windDownSet, "set");            // non-immutable SLOAD last
```

**Rationale**: when an input check reverts AFTER a cold SLOAD, the caller pays ~2100 gas for the SLOAD
before reverting. Ordering cheap calldata/immutable checks before non-immutable SLOAD checks is
pareto-better: same cost on success, SLOADs skipped on failing calls.

**Safety (L1)**: preserve the revert reason a caller hits for a given bad input where integrators may
depend on precedence; otherwise reordering pure validation is behavior-neutral on the success path.

Source: https://solodit.cyfrin.io/issues/reorder-calldata-input-checks-before-non-immutable-storage-reads-in-8-admin-setters-cyfrin-none-armada-crowdfund-governance-markdown

### U2. Remove always-true conditions; order short-circuit operands cheapest-first (L1)

**Before**
```solidity
// sc != address(0) is implied: msg.sender is never address(0), so msg.sender == sc already pins it non-zero
require(msg.sender == sc && sc != address(0), "not sc");
```

**After**
```solidity
require(msg.sender == sc, "not sc");
```

**Rationale**: a conjunct that is always true when reached costs an EQ + AND on every call for nothing.
Separately, order `&&`/`||` operands cheapest-first so the expensive operand is skipped when the cheap one
already decides the result.

**Safety (L1)**: prove the removed condition is genuinely implied on every reachable path before deleting
it (the example relies on `msg.sender != address(0)`, which always holds). Reordering short-circuits must
not move a side-effecting call earlier.

Source: https://solodit.cyfrin.io/issues/redundant-sc-address0-check-in-shieldpausecontrollerpauseshields-cyfrin-none-armada-crowdfund-governance-markdown

## CATEGORY V: External-call batching (L1)

### V1. Combine multiple external calls to the same target into one helper (L1)

**Before**
```solidity
address s = steward.currentSteward();
bool active = steward.isStewardActive();   // 2nd CALL, often re-reading the same storage on the callee
```

**After**
```solidity
(address s, bool active) = steward.getCurrentSteward();   // one CALL
// on the target:
function getCurrentSteward() external view returns (address steward_, bool active_) {
    steward_ = currentSteward;
    active_  = steward_ != address(0) && block.timestamp < termEnd;
}
```

**Rationale**: each external CALL costs ~700 gas warm plus any duplicate SLOADs the secondary getter
repeats. A combined entry point returns everything in one call.

**Safety (L1 on the caller; the new view on the target is an interface addition)**: adding a combined
getter is additive (does not change existing signatures). Ensure the combined view returns exactly what the
separate calls did.

Source: https://solodit.cyfrin.io/issues/optimize-away-redundant-external-calls-by-adding-combined-helpers-cyfrin-none-armada-crowdfund-governance-markdown

## CATEGORY W: Function return shape (L1)

### W1. Named return variable to eliminate a redundant local + explicit `return` (L1)

**Before**
```solidity
function f() external view returns (uint256) {
    uint256 total = token.totalSupply();
    // ...
    return total;
}
```

**After**
```solidity
function f() external view returns (uint256 total) {
    total = token.totalSupply();
    // ...
}
```

**Rationale**: a local declared solely to accumulate the return value, then returned, costs a redundant
stack allocation and an explicit `return`. A named return parameter removes both.

**Safety (L1)**: return value and signature are unchanged. Make sure every path assigns the named return
(or returns explicitly) so you don't accidentally return the default.

Source: https://solodit.cyfrin.io/issues/use-named-return-variable-to-eliminate-redundant-local-in-4-functions-cyfrin-none-armada-crowdfund-governance-markdown

## CATEGORY X: Loops (L1)

### X1. Cache array length outside the loop; consider `unchecked` increment (L1)

**Before**
```solidity
for (uint256 i = 0; i < items.length; ++i) { /* ... */ }
```

**After**
```solidity
uint256 len = items.length;
for (uint256 i; i < len;) {
    // ...
    unchecked { ++i; }     // counter cannot overflow len
}
```

**Rationale**: reading `arr.length` each iteration repeats a load (worse for `storage` arrays than
`memory`/`calldata`); the loop counter cannot overflow, so its increment can be `unchecked`.

**Safety (L1)**: behavior-neutral. NOTE: with the IR pipeline (`--via-ir` / `solc --ir-optimized
--optimize`) the compiler already performs much of this, so the manual win shrinks - the gas-snapshot gate
decides whether to keep it.

Source: https://solodit.cyfrin.io/?i=GAS&s=cache+array+length  (Ondo, Beefy, Swell - Dacian)

### X2. `++i` over `i++` / `i += 1` (L1)

**Before**
```solidity
for (uint256 i = 0; i < n; i++) { /* ... */ }
```

**After**
```solidity
for (uint256 i = 0; i < n; ++i) { /* ... */ }
```

**Rationale**: post-increment must store a temporary copy of the pre-value; pre-increment does not (~5 gas
per iteration).

**Safety (L1)**: equivalent when the increment's value is not used in an expression (true in a normal loop
step). Optimizer-dependent - verify via snapshot.

Source: https://solodit.cyfrin.io/?i=GAS&s=%2B%2Bi+costs+less  (Rigor, BadgerDAO, JPEG'd)

## CATEGORY Y: Arithmetic & initialization micro-opts (L1)

### Y1. `unchecked` block where overflow/underflow is provably impossible (L1; fuzz recommended)

**Before**
```solidity
require(balance >= amount, "insufficient");
balance = balance - amount;          // redundant underflow check inserted by 0.8+
```

**After**
```solidity
require(balance >= amount, "insufficient");
unchecked { balance = balance - amount; }   // safe: guarded by the require above
```

**Rationale**: Solidity 0.8+ inserts overflow/underflow checks on every op. When a prior condition
guarantees safety, `unchecked` skips the check.

**Safety (L1, high-care)**: this does NOT remove a check - it wraps an op whose safety a prior
`require`/condition already guarantees. State that invariant in a comment. This is exactly cross-cutting
rule 2's danger zone (a careless `unchecked` reintroduces overflow), so treat it like E1/F2: recommend the
fuzz opt-in, and never wrap arithmetic in `unchecked` just to hit a gas target.

Source: https://solodit.cyfrin.io/?i=GAS&s=unchecked+block  (Curves, Frankencoin, LI.FI, Olas)

### Y2. `!= 0` instead of `> 0` for unsigned (legacy compilers) (L1)

**Before**
```solidity
require(amount > 0, "zero");
```

**After**
```solidity
require(amount != 0, "zero");
```

**Rationale**: on compilers up to ~0.8.13 with the optimizer enabled, inside a `require`, `!= 0` is ~6 gas
cheaper than `> 0` for unsigned integers.

**Safety (L1)**: equivalent only for unsigned types. Version-dependent - on newer compilers the difference
is largely gone; the gas-snapshot gate decides whether it is worth keeping. Do not over-rely on this.

Source: https://solodit.cyfrin.io/?i=GAS&s=%21%3D0  (Foundation, Yieldy, LI.FI)

### Y3. `x = x + y` instead of `x += y` for state variables (L1)

**Before**
```solidity
balance += amount;        // state variable
```

**After**
```solidity
balance = balance + amount;
```

**Rationale**: for state variables the compound assignment operators generate slightly more code than the
explicit form (~113 gas per instance reported in audited code). Does not apply to memory/local variables.

**Safety (L1)**: arithmetically identical. Small and optimizer-dependent - verify via snapshot.

Source: https://solodit.cyfrin.io/?i=GAS&s=%3Cx%3E+%2B%3D  (PoolTogether, Goldilocks, GoGoPool)

### Y4. No explicit default-value initialization (L1)

**Before**
```solidity
uint256 total = 0;
bool active = false;
for (uint256 i = 0; i < n; ++i) { /* ... */ }
```

**After**
```solidity
uint256 total;
bool active;
for (uint256 i; i < n; ++i) { /* ... */ }
```

**Rationale**: explicit `= 0` / `= false` at declaration emits a redundant zero-init sequence; Solidity
already default-initializes every type to its zero-equivalent.

**Safety (L1)**: behavior-neutral.

Source: https://solodit.cyfrin.io/issues/default-value-initialisations-in-armadacrowdfund-and-revenuelock-are-redundant-cyfrin-none-armada-crowdfund-governance-markdown

---

## PART 3 NOTES (sourcing, magnitude, safety)

**Sourcing**: these are audit-reported techniques, not benchmarked in this corpus. Use the verification
gate to confirm each on the target.

**Magnitude (where to spend effort)**:
- High-value, robust: Q1-Q3 (avoided SLOADs ~100-2100 each), R1 (avoided SLOAD per read), V1 (~700/CALL +
  duplicate SLOADs), U1 (cold SLOAD skipped on the revert path). Do these first.
- Low single/double-digit, version-dependent: X1, X2, Y2, Y3, Y4. With `--via-ir` the compiler already does
  several of them. Keep only if the snapshot drops; discard anything within noise (cross-cutting rule per
  Part 1's measured-results lesson).

**Part 3 cross-cutting safety additions**:
- Reorderings (Q3, U1, U2) must not change observable semantics: event ORDER (Q3) and revert
  reason/precedence (U1) can be relied on by integrators - preserve them.
- `calldata` (S1) and signature changes (S2) are only L1 when the function is `internal` or genuinely
  external-only; otherwise a selector change is an interface change.
- Y1 (`unchecked`) is the one Part 3 transform that can introduce a vulnerability if the proving is wrong -
  treat it with the same fuzz discipline as E1/F2/N2, and document the invariant that makes it safe.
