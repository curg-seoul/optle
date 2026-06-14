// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StakingPool — a deliberately gas-inefficient staking/rewards pool.
/// @notice Pure-accounting (no real token transfers) so behaviour is easy to test.
///         Written with common anti-patterns catalogued in WTF-gas-optimization:
///         require-strings, checked loop counters / i++, init-to-default,
///         public-instead-of-external, unpacked structs, mapping<bool> flags, and
///         repeated SLOADs of array length + storage inside loops. The external
///         interface (function signatures, events, return shapes) is the contract
///         under test — an optimizer must preserve it exactly.
contract StakingPool {
    // Could be constant/immutable; kept as storage on purpose.
    string public name = "Naive Staking Pool";
    uint256 public rewardRateBps = 500; // 5% per distribution
    address public owner;

    // Unpacked struct: `since` (timestamp) + `active` + `staker` could share a slot
    // with a smaller `amount` type, but everything here is a full 32-byte slot.
    struct StakeInfo {
        uint256 amount;
        uint256 since;
        bool active;
        address staker;
    }

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public rewards;
    mapping(address => bool) public hasStaked; // a bitmap/flag candidate
    address[] public stakers;

    uint256 public totalStaked;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "StakingPool: caller is not the contract owner");
        _;
    }

    function stake(uint256 amount) public {
        require(amount > 0, "StakingPool: stake amount must be greater than zero");
        require(!stakes[msg.sender].active, "StakingPool: caller already has an active stake");

        stakes[msg.sender] = StakeInfo({
            amount: amount,
            since: block.timestamp,
            active: true,
            staker: msg.sender
        });

        if (hasStaked[msg.sender] == false) {
            hasStaked[msg.sender] = true;
            stakers.push(msg.sender);
        }

        totalStaked = totalStaked + amount;
        emit Staked(msg.sender, amount);
    }

    function unstake() public {
        require(stakes[msg.sender].active, "StakingPool: caller has no active stake to withdraw");

        uint256 amount = stakes[msg.sender].amount;
        stakes[msg.sender].active = false;
        stakes[msg.sender].amount = 0;
        totalStaked = totalStaked - amount;
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Accrue rewards to every active staker. Re-reads `stakers.length`
    ///         and `stakes[...]` from storage on every iteration.
    function distributeRewards() public onlyOwner {
        for (uint256 i = 0; i < stakers.length; i++) {
            address s = stakers[i];
            if (stakes[s].active == true) {
                uint256 reward = (stakes[s].amount * rewardRateBps) / 10000;
                rewards[s] = rewards[s] + reward;
            }
        }
    }

    function claim() public {
        uint256 amount = rewards[msg.sender];
        require(amount > 0, "StakingPool: no rewards available to claim");
        rewards[msg.sender] = 0;
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Sum of all outstanding rewards. Naive loop with default init + i++.
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

    function stakerCount() public view returns (uint256) {
        return stakers.length;
    }

    function setRewardRate(uint256 newRateBps) public onlyOwner {
        require(newRateBps <= 10000, "StakingPool: reward rate exceeds 100 percent");
        rewardRateBps = newRateBps;
    }
}
