// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/StakingPool.sol";

contract StakingPoolTest is Test {
    StakingPool pool;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address dave = address(0xDA7E);

    function setUp() public {
        pool = new StakingPool();
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        pool.stake(amount);
    }

    function testStakeRecordsState() public {
        _stake(alice, 1_000);
        (uint256 amount,, bool active, address staker, uint256 tier, bool exists) = pool.stakes(alice);
        assertEq(amount, 1_000);
        assertTrue(active);
        assertEq(staker, alice);
        assertEq(tier, 1);
        assertTrue(exists);
        assertEq(pool.totalStaked(), 1_000);
        assertEq(pool.stakerCount(), 1);
    }

    function testStakeZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        pool.stake(0);
    }

    function testDoubleStakeReverts() public {
        _stake(alice, 100);
        vm.prank(alice);
        vm.expectRevert();
        pool.stake(200);
    }

    function testDistributeAndClaim() public {
        _stake(alice, 10_000);
        _stake(bob, 20_000);

        pool.distributeRewards(); // 5%: alice 500, bob 1000

        assertEq(pool.rewards(alice), 500);
        assertEq(pool.rewards(bob), 1_000);
        assertEq(pool.totalRewards(), 1_500);

        vm.prank(alice);
        pool.claim();
        assertEq(pool.rewards(alice), 0);
        assertEq(pool.totalRewards(), 1_000);
        assertEq(pool.totalRewardsPaid(), 500);
        assertTrue(pool.hasClaimed(alice));
    }

    function testTierBonus() public {
        _stake(alice, 100_000); // tier 2 → base 5000 + bonus 1000
        pool.distributeRewards();
        assertEq(pool.rewards(alice), 6_000);
    }

    function testDistributeOnlyOwner() public {
        _stake(alice, 1_000);
        vm.prank(alice);
        vm.expectRevert();
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
        vm.expectRevert();
        pool.claim();
    }

    function testSetRewardRate() public {
        pool.setRewardRate(1_000); // 10%
        _stake(alice, 10_000);
        pool.distributeRewards();
        assertEq(pool.rewards(alice), 1_000);
    }

    function testSetRewardRateTooHighReverts() public {
        vm.expectRevert();
        pool.setRewardRate(10_001);
    }

    function testBatchStake() public {
        address[] memory users = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        users[0] = alice; users[1] = bob;
        amounts[0] = 1_000; amounts[1] = 2_000;

        pool.batchStake(users, amounts);
        assertEq(pool.stakerCount(), 2);
        assertEq(pool.totalStaked(), 3_000);
        assertTrue(pool.isStaker(alice));
        assertTrue(pool.isStaker(bob));
        assertFalse(pool.isStaker(dave));
    }

    function testBatchStakeLengthMismatchReverts() public {
        address[] memory users = new address[](2);
        uint256[] memory amounts = new uint256[](1);
        users[0] = alice; users[1] = bob;
        amounts[0] = 1_000;
        vm.expectRevert();
        pool.batchStake(users, amounts);
    }

    function testTopStaker() public {
        _stake(alice, 1_000);
        _stake(bob, 5_000);
        _stake(dave, 3_000);
        assertEq(pool.topStaker(), bob);
    }

    function testRemoveStaker() public {
        _stake(alice, 1_000);
        _stake(bob, 2_000);
        assertEq(pool.stakerCount(), 2);

        pool.removeStaker(alice);
        assertEq(pool.stakerCount(), 1);
        assertFalse(pool.hasStaked(alice));
        assertFalse(pool.isStaker(alice));
        assertTrue(pool.isStaker(bob));
        assertEq(pool.totalStaked(), 2_000);
    }

    function testRemoveUnknownStakerReverts() public {
        vm.expectRevert();
        pool.removeStaker(dave);
    }

    function testBlacklistBlocksStake() public {
        pool.blacklist(alice);
        vm.prank(alice);
        vm.expectRevert();
        pool.stake(1_000);
    }

    function testRecomputeAll() public {
        _stake(alice, 10_000);
        pool.distributeRewards();
        pool.recomputeAll();
        assertEq(pool.rewards(alice), 500);
    }

    /// Heavier path so the gas report has a meaningful loop cost to optimize.
    function testManyStakersDistribute() public {
        for (uint256 i = 0; i < 40; i++) {
            address s = address(uint160(0x1000 + i));
            _stake(s, 1_000 + i);
        }
        pool.distributeRewards();
        pool.recomputeAll();
        pool.totalRewards();
        pool.activeStakerCount();
        pool.topStaker();
        assertEq(pool.stakerCount(), 40);
    }
}
