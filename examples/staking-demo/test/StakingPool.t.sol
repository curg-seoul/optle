// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/StakingPool.sol";

contract StakingPoolTest is Test {
    StakingPool pool;
    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        pool = new StakingPool();
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        pool.stake(amount);
    }

    function testStakeRecordsState() public {
        _stake(alice, 1_000);
        (uint256 amount,, bool active, address staker) = pool.stakes(alice);
        assertEq(amount, 1_000);
        assertTrue(active);
        assertEq(staker, alice);
        assertEq(pool.totalStaked(), 1_000);
        assertEq(pool.stakerCount(), 1);
    }

    function testStakeZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(bytes("StakingPool: stake amount must be greater than zero"));
        pool.stake(0);
    }

    function testDoubleStakeReverts() public {
        _stake(alice, 100);
        vm.prank(alice);
        vm.expectRevert(bytes("StakingPool: caller already has an active stake"));
        pool.stake(200);
    }

    function testDistributeAndClaim() public {
        _stake(alice, 10_000);
        _stake(bob, 20_000);

        pool.distributeRewards(); // 5% → alice 500, bob 1000

        assertEq(pool.rewards(alice), 500);
        assertEq(pool.rewards(bob), 1_000);
        assertEq(pool.totalRewards(), 1_500);

        vm.prank(alice);
        pool.claim();
        assertEq(pool.rewards(alice), 0);
        assertEq(pool.totalRewards(), 1_000);
    }

    function testDistributeOnlyOwner() public {
        _stake(alice, 1_000);
        vm.prank(alice);
        vm.expectRevert(bytes("StakingPool: caller is not the contract owner"));
        pool.distributeRewards();
    }

    function testUnstakeStopsRewards() public {
        _stake(alice, 1_000);
        _stake(bob, 1_000);

        vm.prank(alice);
        pool.unstake();
        assertEq(pool.totalStaked(), 1_000);
        assertEq(pool.activeStakerCount(), 1);

        pool.distributeRewards(); // only bob active → 50
        assertEq(pool.rewards(alice), 0);
        assertEq(pool.rewards(bob), 50);
    }

    function testClaimWithoutRewardsReverts() public {
        _stake(alice, 1_000);
        vm.prank(alice);
        vm.expectRevert(bytes("StakingPool: no rewards available to claim"));
        pool.claim();
    }

    function testSetRewardRate() public {
        pool.setRewardRate(1_000); // 10%
        _stake(alice, 10_000);
        pool.distributeRewards();
        assertEq(pool.rewards(alice), 1_000);
    }

    function testSetRewardRateTooHighReverts() public {
        vm.expectRevert(bytes("StakingPool: reward rate exceeds 100 percent"));
        pool.setRewardRate(10_001);
    }

    /// Heavier path so the gas report has a meaningful loop cost to optimize.
    function testManyStakersDistribute() public {
        for (uint256 i = 0; i < 30; i++) {
            address s = address(uint160(0x1000 + i));
            _stake(s, 1_000 + i);
        }
        pool.distributeRewards();
        pool.totalRewards();
        pool.activeStakerCount();
        assertEq(pool.stakerCount(), 30);
    }
}
