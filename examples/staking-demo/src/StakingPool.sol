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
    string public name = "Naive Staking Pool";          // constant candidate
    string public symbol = "NSP";                       // constant candidate
    uint256 public rewardRateBps = 500;                 // immutable/constant candidate (5%)
    uint256 public bonusRateBps = 100;                  // immutable/constant candidate (1%)
    uint256 public maxStakers = 1000;                   // constant candidate
    address public owner;

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
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "StakingPool: caller is not the contract owner of this pool");
        _;
    }

    function stake(uint256 amount) public {
        require(amount > 0, "StakingPool: stake amount must be strictly greater than zero wei");
        require(!stakes[msg.sender].active, "StakingPool: caller already has an active stake position");
        require(!isBlacklisted[msg.sender], "StakingPool: caller address has been blacklisted by the owner");

        uint256 tier = 0;
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

        if (hasStaked[msg.sender] == false) {
            hasStaked[msg.sender] = true;
            stakers.push(msg.sender);
        }

        totalStaked = totalStaked + amount;
        emit Staked(msg.sender, amount);
    }

    /// @notice Owner stakes on behalf of many users. `memory` params (calldata
    ///         candidate), length check with a long string, re-reads length, i++.
    function batchStake(address[] memory users, uint256[] memory amounts) public onlyOwner {
        require(users.length == amounts.length, "StakingPool: users and amounts array lengths must be exactly equal");
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            if (isBlacklisted[user] == true) {
                continue;
            }
            if (stakes[user].active == true) {
                continue;
            }
            uint256 tier = 0;
            if (amounts[i] >= 100000) {
                tier = 2;
            } else if (amounts[i] >= 1000) {
                tier = 1;
            }
            stakes[user] = StakeInfo({
                amount: amounts[i],
                since: block.timestamp,
                active: true,
                staker: user,
                tier: tier,
                exists: true
            });
            if (hasStaked[user] == false) {
                hasStaked[user] = true;
                stakers.push(user);
            }
            totalStaked = totalStaked + amounts[i];
            emit Staked(user, amounts[i]);
        }
    }

    function unstake() public {
        require(stakes[msg.sender].active, "StakingPool: caller has no active stake position to withdraw");
        uint256 amount = stakes[msg.sender].amount;
        stakes[msg.sender].active = false;
        stakes[msg.sender].amount = 0;
        totalStaked = totalStaked - amount;
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Accrue rewards to every active staker. Re-reads `stakers.length`
    ///         and `stakes[...]` (multiple SLOADs) every iteration.
    function distributeRewards() public onlyOwner {
        for (uint256 i = 0; i < stakers.length; i++) {
            address s = stakers[i];
            if (stakes[s].active == true) {
                uint256 base = (stakes[s].amount * rewardRateBps) / 10000;
                uint256 bonus = 0;
                if (stakes[s].tier == 2) {
                    bonus = (stakes[s].amount * bonusRateBps) / 10000;
                }
                rewards[s] = rewards[s] + base + bonus;
            }
        }
    }

    /// @notice Recompute everyone's reward from scratch. Redundant repeated SLOADs.
    function recomputeAll() public onlyOwner {
        for (uint256 i = 0; i < stakers.length; i++) {
            rewards[stakers[i]] = (stakes[stakers[i]].amount * rewardRateBps) / 10000;
        }
    }

    function claim() public {
        uint256 amount = rewards[msg.sender];
        require(amount > 0, "StakingPool: there are no rewards currently available to claim");
        rewards[msg.sender] = 0;
        hasClaimed[msg.sender] = true;
        totalRewardsPaid = totalRewardsPaid + amount;
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Sum of all outstanding rewards. Default init + i++ + length re-read.
    function totalRewards() public view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < stakers.length; i++) {
            total = total + rewards[stakers[i]];
        }
        return total;
    }

    /// @notice Count active stakers. Re-reads length + storage each iteration.
    function activeStakerCount() public view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < stakers.length; i++) {
            if (stakes[stakers[i]].active == true) {
                count = count + 1;
            }
        }
        return count;
    }

    /// @notice Highest-amount active staker. Linear scan re-reading storage.
    function topStaker() public view returns (address) {
        address top = address(0);
        uint256 max = 0;
        for (uint256 i = 0; i < stakers.length; i++) {
            if (stakes[stakers[i]].active == true && stakes[stakers[i]].amount > max) {
                max = stakes[stakers[i]].amount;
                top = stakers[i];
            }
        }
        return top;
    }

    /// @notice O(n) membership check that ignores the O(1) `hasStaked` mapping.
    function isStaker(address user) public view returns (bool) {
        for (uint256 i = 0; i < stakers.length; i++) {
            if (stakers[i] == user) {
                return true;
            }
        }
        return false;
    }

    /// @notice Remove a staker by linear scan + array shift. O(n) anti-pattern.
    function removeStaker(address user) public onlyOwner {
        require(hasStaked[user], "StakingPool: the provided address is not a known staker of this pool");
        uint256 index = 0;
        bool found = false;
        for (uint256 i = 0; i < stakers.length; i++) {
            if (stakers[i] == user) {
                index = i;
                found = true;
                break;
            }
        }
        require(found, "StakingPool: staker not found while scanning the stakers array");

        for (uint256 j = index; j < stakers.length - 1; j++) {
            stakers[j] = stakers[j + 1];
        }
        stakers.pop();

        if (stakes[user].active == true) {
            totalStaked = totalStaked - stakes[user].amount;
        }
        hasStaked[user] = false;
        stakes[user].active = false;
        stakes[user].exists = false;
        rewards[user] = 0;
        emit StakerRemoved(user);
    }

    function blacklist(address user) public onlyOwner {
        isBlacklisted[user] = true;
    }

    function setRewardRate(uint256 newRateBps) public onlyOwner {
        require(newRateBps <= 10000, "StakingPool: reward rate must not exceed one hundred percent (10000 bps)");
        rewardRateBps = newRateBps;
    }

    function stakerCount() public view returns (uint256) {
        return stakers.length;
    }
}
