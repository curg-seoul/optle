// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Airdrop.sol";

contract AirdropTest is Test {
    Airdrop drop;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address dave = address(0xDA7E);

    function setUp() public {
        drop = new Airdrop();
    }

    function _allocate(address[] memory users, uint256[] memory amounts) internal {
        drop.setAllocations(users, amounts);
    }

    function testSetAllocations() public {
        address[] memory users = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        users[0] = alice; users[1] = bob;
        amounts[0] = 1_000; amounts[1] = 2_000;

        _allocate(users, amounts);

        assertEq(drop.recipientCount(), 2);
        assertEq(drop.totalAllocated(), 3_000);
        assertEq(drop.totalUnclaimed(), 3_000);
        assertTrue(drop.isRecipient(alice));
        assertFalse(drop.isRecipient(dave));
        assertEq(drop.remainingFor(alice), 1_000);
    }

    function testSetAllocationsOnlyOwner() public {
        address[] memory users = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        users[0] = alice; amounts[0] = 1_000;
        vm.prank(alice);
        vm.expectRevert();
        drop.setAllocations(users, amounts);
    }

    function testLengthMismatchReverts() public {
        address[] memory users = new address[](2);
        uint256[] memory amounts = new uint256[](1);
        users[0] = alice; users[1] = bob;
        amounts[0] = 1_000;
        vm.expectRevert();
        drop.setAllocations(users, amounts);
    }

    function testClaim() public {
        address[] memory users = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        users[0] = alice; users[1] = bob;
        amounts[0] = 1_000; amounts[1] = 2_000;
        _allocate(users, amounts);

        vm.prank(alice);
        drop.claim();

        assertTrue(drop.hasClaimed(alice));
        assertEq(drop.totalClaimed(), 1_000);
        assertEq(drop.claimedCount(), 1);
        assertEq(drop.totalUnclaimed(), 2_000);
        assertEq(drop.remainingFor(alice), 0);
    }

    function testDoubleClaimReverts() public {
        address[] memory users = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        users[0] = alice; amounts[0] = 1_000;
        _allocate(users, amounts);

        vm.prank(alice);
        drop.claim();
        vm.prank(alice);
        vm.expectRevert();
        drop.claim();
    }

    function testClaimUnregisteredReverts() public {
        vm.prank(dave);
        vm.expectRevert();
        drop.claim();
    }

    function testManyRecipients() public {
        address[] memory users = new address[](40);
        uint256[] memory amounts = new uint256[](40);
        for (uint256 i = 0; i < 40; i++) {
            users[i] = address(uint160(0x2000 + i));
            amounts[i] = 100 + i;
        }
        _allocate(users, amounts);
        drop.totalUnclaimed();
        drop.claimedCount();
        assertEq(drop.recipientCount(), 40);
        assertTrue(drop.isRecipient(address(uint160(0x2000 + 39))));
    }
}
