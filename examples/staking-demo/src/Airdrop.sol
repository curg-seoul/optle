// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Airdrop — a deliberately gas-INEFFICIENT token airdrop distributor.
/// @notice Pure-accounting (no real token) so behaviour is easy to test. Same
///         anti-pattern spirit as StakingPool: long require strings, mapping<bool>
///         flags, O(n) linear scans, loops that re-read `array.length` + storage,
///         `memory` array params (calldata candidates), `uint x = 0`, `i++`,
///         checked math, and storage vars that should be constant/immutable.
contract Airdrop {
    string public name = "Naive Airdrop Distributor"; // constant candidate
    uint256 public claimFeeBps = 0;                    // immutable/constant candidate
    address public owner;

    struct Allocation {
        uint256 amount;
        bool claimed;
        address recipient;
        uint256 updatedAt;
    }

    mapping(address => Allocation) public allocations;
    mapping(address => bool) public isRegistered; // flag #1
    mapping(address => bool) public hasClaimed;   // flag #2
    address[] public recipients;

    uint256 public totalAllocated;
    uint256 public totalClaimed;

    event AllocationSet(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Airdrop: caller is not the owner of this airdrop contract");
        _;
    }

    /// @notice Owner sets allocations. `memory` params (calldata candidate), long
    ///         require string, re-reads `users.length`, i++, duplicate SSTOREs.
    function setAllocations(address[] memory users, uint256[] memory amounts) public onlyOwner {
        require(users.length == amounts.length, "Airdrop: users and amounts arrays must have exactly the same length");
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            require(amounts[i] > 0, "Airdrop: allocation amount for each user must be greater than zero");

            if (isRegistered[user] == false) {
                isRegistered[user] = true;
                recipients.push(user);
            }
            allocations[user] = Allocation({
                amount: amounts[i],
                claimed: false,
                recipient: user,
                updatedAt: block.timestamp
            });
            totalAllocated = totalAllocated + amounts[i];
            emit AllocationSet(user, amounts[i]);
        }
    }

    function claim() public {
        require(isRegistered[msg.sender], "Airdrop: caller does not have any registered allocation to claim");
        require(hasClaimed[msg.sender] == false, "Airdrop: caller has already claimed their airdrop allocation");

        uint256 amount = allocations[msg.sender].amount;
        require(amount > 0, "Airdrop: there is no positive allocation available for the caller");

        hasClaimed[msg.sender] = true;
        allocations[msg.sender].claimed = true;
        totalClaimed = totalClaimed + amount;
        emit Claimed(msg.sender, amount);
    }

    /// @notice Sum of all unclaimed allocations. Loop re-reads length + storage.
    function totalUnclaimed() public view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (allocations[recipients[i]].claimed == false) {
                total = total + allocations[recipients[i]].amount;
            }
        }
        return total;
    }

    /// @notice Number of recipients who have claimed. Loop re-reads storage.
    function claimedCount() public view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (hasClaimed[recipients[i]] == true) {
                count = count + 1;
            }
        }
        return count;
    }

    /// @notice O(n) membership scan that ignores the O(1) `isRegistered` mapping.
    function isRecipient(address user) public view returns (bool) {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == user) {
                return true;
            }
        }
        return false;
    }

    function recipientCount() public view returns (uint256) {
        return recipients.length;
    }

    function remainingFor(address user) public view returns (uint256) {
        if (hasClaimed[user] == true) {
            return 0;
        }
        return allocations[user].amount;
    }
}
