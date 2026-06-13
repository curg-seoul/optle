// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Rewards} from "../src/Rewards.sol";

// No forge-std dependency: forge discovers `test*` functions and produces a
// gas report for every contract function they exercise. Assertions use require
// so a behavior change fails the run — this is the safety net that proves the
// optimization preserved semantics.
contract RewardsTest {
    function test_computeTotal() public {
        Rewards r = new Rewards();
        for (uint256 i = 1; i <= 50; i++) {
            r.add(i);
        }
        require(r.computeTotal() == 1275, "wrong total");
        require(r.total() == 1275, "total not stored");
        require(r.count() == 50, "wrong count");
    }

    function test_addRejectsZero() public {
        Rewards r = new Rewards();
        (bool ok, ) = address(r).call(abi.encodeWithSignature("add(uint256)", uint256(0)));
        require(!ok, "zero amount should revert");
    }
}
