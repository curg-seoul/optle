// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StakingPool — a deliberately gas-INEFFICIENT staking/rewards pool.
/// @notice Pure-accounting (no real token transfers) so behaviour is easy to test.
///         Packed with gas anti-patterns (WTF-gas-optimization catalogue) for a
///         dramatic optimization demo. The EXTERNAL interface (function
///         signatures, events, return shapes) is what the tests pin — an optimizer
///         must preserve it while it is free to redesign internal storage.
///
/// Anti-patterns on purpose:
///   - storage vars that should be constant/immutable (name, symbol, rates, caps)
///   - long require() reason strings instead of custom errors
///   - several separate mapping(address => bool) flags (bitmap candidates)
///   - a wide, unpacked struct (full 32-byte slot per field)
///   - O(n) linear scans + array shifting where a mapping would be O(1)
///   - loops that re-read `array.length` and re-read storage every iteration
///   - `memory` array parameters that could be `calldata`
///   - `uint x = 0` default initialization, `i++` post-increment, checked math
///   - redundant/duplicate storage writes
contract StakingPool {
    error NotOwner();
    error LengthMismatch();
    error ZeroAmount();
    error AlreadyActive();
    error Blacklisted();
    error NoActiveStake();
    error NoRewards();
    error RateTooHigh();
    error NotAStaker();
    error StakerNotFound();

    string public constant name = "Naive Staking Pool";          // constant candidate
    string public constant symbol = "NSP";                       // constant candidate
    uint256 public rewardRateBps = 500;                 // immutable/constant candidate (5%)
    uint256 public immutable bonusRateBps;              // immutable/constant candidate (1%)
    uint256 public constant maxStakers = 1000;                   // constant candidate
    address public immutable owner;

    // Wide unpacked struct: `since`, `active`, `staker`, `tier`, `exists` could all
    // be packed; here every field eats a full slot.
    struct StakeInfo {
        uint256 amount;
        uint256 since;
        bool active;
        address staker;
        uint256 tier;
        bool exists;
    }

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public rewards;
    mapping(address => bool) public hasStaked;     // flag #1
    mapping(address => bool) public isBlacklisted; // flag #2
    mapping(address => bool) public hasClaimed;    // flag #3
    address[] public stakers;

    uint256 public totalStaked;
    uint256 public totalRewardsPaid;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event StakerRemoved(address indexed user);

    constructor() {
        owner = msg.sender;
        bonusRateBps = 100;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (stakes[msg.sender].active) revert AlreadyActive();
        if (isBlacklisted[msg.sender]) revert Blacklisted();

        uint256 tier;
        if (amount >= 100000) {
            tier = 2;
        } else if (amount >= 1000) {
            tier = 1;
        }

        stakes[msg.sender] = StakeInfo({
            amount: amount,
            since: block.timestamp,
            active: true,
            staker: msg.sender,
            tier: tier,
            exists: true
        });

        if (!hasStaked[msg.sender]) {
            hasStaked[msg.sender] = true;
            stakers.push(msg.sender);
        }

        totalStaked = totalStaked + amount;
        emit Staked(msg.sender, amount);
    }

    /// @notice Owner stakes on behalf of many users. `memory` params (calldata
    ///         candidate), length check with a long string, re-reads length, i++.
    function batchStake(address[] calldata users, uint256[] calldata amounts) external onlyOwner {
        uint256 len = users.length;
        if (len != amounts.length) revert LengthMismatch();
        uint256 staked = totalStaked;
        for (uint256 i; i < len;) {
            address user = users[i];
            if (isBlacklisted[user]) {
                unchecked { ++i; }
                continue;
            }
            if (stakes[user].active) {
                unchecked { ++i; }
                continue;
            }
            uint256 amount = amounts[i];
            uint256 tier;
            if (amount >= 100000) {
                tier = 2;
            } else if (amount >= 1000) {
                tier = 1;
            }
            stakes[user] = StakeInfo({
                amount: amount,
                since: block.timestamp,
                active: true,
                staker: user,
                tier: tier,
                exists: true
            });
            if (!hasStaked[user]) {
                hasStaked[user] = true;
                stakers.push(user);
            }
            staked = staked + amount;
            emit Staked(user, amount);
            unchecked { ++i; }
        }
        totalStaked = staked;
    }

    function unstake() external {
        if (!stakes[msg.sender].active) revert NoActiveStake();
        uint256 amount = stakes[msg.sender].amount;
        stakes[msg.sender].active = false;
        stakes[msg.sender].amount = 0;
        totalStaked = totalStaked - amount;
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Accrue rewards to every active staker. Re-reads `stakers.length`
    ///         and `stakes[...]` (multiple SLOADs) every iteration.
    function distributeRewards() external onlyOwner {
        uint256 len = stakers.length;
        uint256 rate = rewardRateBps;
        for (uint256 i; i < len;) {
            address s = stakers[i];
            StakeInfo storage info = stakes[s];
            if (info.active) {
                uint256 amount = info.amount;
                uint256 base = (amount * rate) / 10000;
                uint256 bonus;
                if (info.tier == 2) {
                    bonus = (amount * bonusRateBps) / 10000;
                }
                rewards[s] = rewards[s] + base + bonus;
            }
            unchecked { ++i; }
        }
    }

    /// @notice Recompute everyone's reward from scratch. Redundant repeated SLOADs.
    function recomputeAll() external onlyOwner {
        uint256 len = stakers.length;
        uint256 rate = rewardRateBps;
        for (uint256 i; i < len;) {
            address s = stakers[i];
            rewards[s] = (stakes[s].amount * rate) / 10000;
            unchecked { ++i; }
        }
    }

    function claim() external {
        uint256 amount = rewards[msg.sender];
        if (amount == 0) revert NoRewards();
        rewards[msg.sender] = 0;
        hasClaimed[msg.sender] = true;
        totalRewardsPaid = totalRewardsPaid + amount;
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Sum of all outstanding rewards. Default init + i++ + length re-read.
    function totalRewards() external view returns (uint256 total) {
        uint256 len = stakers.length;
        for (uint256 i; i < len;) {
            total = total + rewards[stakers[i]];
            unchecked { ++i; }
        }
    }

    /// @notice Count active stakers. Re-reads length + storage each iteration.
    function activeStakerCount() external view returns (uint256 count) {
        uint256 len = stakers.length;
        for (uint256 i; i < len;) {
            if (stakes[stakers[i]].active) {
                unchecked { ++count; }
            }
            unchecked { ++i; }
        }
    }

    /// @notice Highest-amount active staker. Linear scan re-reading storage.
    function topStaker() external view returns (address top) {
        uint256 max;
        uint256 len = stakers.length;
        for (uint256 i; i < len;) {
            address s = stakers[i];
            StakeInfo storage info = stakes[s];
            if (info.active && info.amount > max) {
                max = info.amount;
                top = s;
            }
            unchecked { ++i; }
        }
    }

    /// @notice O(n) membership check that ignores the O(1) `hasStaked` mapping.
    function isStaker(address user) external view returns (bool) {
        return hasStaked[user];
    }

    /// @notice Remove a staker by linear scan + array shift. O(n) anti-pattern.
    function removeStaker(address user) external onlyOwner {
        if (!hasStaked[user]) revert NotAStaker();
        uint256 len = stakers.length;
        uint256 index;
        bool found;
        for (uint256 i; i < len;) {
            if (stakers[i] == user) {
                index = i;
                found = true;
                break;
            }
            unchecked { ++i; }
        }
        if (!found) revert StakerNotFound();

        for (uint256 j = index; j < len - 1;) {
            stakers[j] = stakers[j + 1];
            unchecked { ++j; }
        }
        stakers.pop();

        StakeInfo storage info = stakes[user];
        if (info.active) {
            totalStaked = totalStaked - info.amount;
        }
        hasStaked[user] = false;
        info.active = false;
        info.exists = false;
        rewards[user] = 0;
        emit StakerRemoved(user);
    }

    function blacklist(address user) external onlyOwner {
        isBlacklisted[user] = true;
    }

    function setRewardRate(uint256 newRateBps) external onlyOwner {
        if (newRateBps > 10000) revert RateTooHigh();
        rewardRateBps = newRateBps;
    }

    function stakerCount() external view returns (uint256) {
        return stakers.length;
    }
}
