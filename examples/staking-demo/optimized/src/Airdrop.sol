// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Airdrop — a deliberately gas-INEFFICIENT token airdrop distributor.
/// @notice Pure-accounting (no real token) so behaviour is easy to test. Same
///         anti-pattern spirit as StakingPool: long require strings, mapping<bool>
///         flags, O(n) linear scans, loops that re-read `array.length` + storage,
///         `memory` array params (calldata candidates), `uint x = 0`, `i++`,
///         checked math, and storage vars that should be constant/immutable.
contract Airdrop {
    error NotOwner();
    error LengthMismatch();
    error ZeroAmount();
    error NotRegistered();
    error AlreadyClaimed();
    error NoAllocation();

    string public constant name = "Naive Airdrop Distributor"; // constant candidate
    uint256 public constant claimFeeBps = 0;                    // immutable/constant candidate
    address public immutable owner;

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
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Owner sets allocations. `memory` params (calldata candidate), long
    ///         require string, re-reads `users.length`, i++, duplicate SSTOREs.
    function setAllocations(address[] calldata users, uint256[] calldata amounts) external onlyOwner {
        uint256 len = users.length;
        if (len != amounts.length) revert LengthMismatch();
        uint256 allocated = totalAllocated;
        for (uint256 i; i < len;) {
            address user = users[i];
            uint256 amount = amounts[i];
            if (amount == 0) revert ZeroAmount();

            if (!isRegistered[user]) {
                isRegistered[user] = true;
                recipients.push(user);
            }
            allocations[user] = Allocation({
                amount: amount,
                claimed: false,
                recipient: user,
                updatedAt: block.timestamp
            });
            allocated = allocated + amount;
            emit AllocationSet(user, amount);
            unchecked { ++i; }
        }
        totalAllocated = allocated;
    }

    function claim() external {
        if (!isRegistered[msg.sender]) revert NotRegistered();
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        uint256 amount = allocations[msg.sender].amount;
        if (amount == 0) revert NoAllocation();

        hasClaimed[msg.sender] = true;
        allocations[msg.sender].claimed = true;
        totalClaimed = totalClaimed + amount;
        emit Claimed(msg.sender, amount);
    }

    /// @notice Sum of all unclaimed allocations. Loop re-reads length + storage.
    function totalUnclaimed() external view returns (uint256 total) {
        uint256 len = recipients.length;
        for (uint256 i; i < len;) {
            Allocation storage a = allocations[recipients[i]];
            if (!a.claimed) {
                total = total + a.amount;
            }
            unchecked { ++i; }
        }
    }

    /// @notice Number of recipients who have claimed. Loop re-reads storage.
    function claimedCount() external view returns (uint256 count) {
        uint256 len = recipients.length;
        for (uint256 i; i < len;) {
            if (hasClaimed[recipients[i]]) {
                unchecked { ++count; }
            }
            unchecked { ++i; }
        }
    }

    /// @notice O(n) membership scan that ignores the O(1) `isRegistered` mapping.
    function isRecipient(address user) external view returns (bool) {
        return isRegistered[user];
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function remainingFor(address user) external view returns (uint256) {
        if (hasClaimed[user]) {
            return 0;
        }
        return allocations[user].amount;
    }
}
