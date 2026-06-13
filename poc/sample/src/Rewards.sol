// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// A deliberately gas-inefficient contract.
// The behavior is correct; the implementation wastes gas in several ways.
contract Rewards {
    address public owner;
    uint256[] public amounts;
    uint256 public total;

    constructor() {
        owner = msg.sender;
    }

    function add(uint256 amount) public {
        require(amount > 0, "amount must be greater than zero");
        amounts.push(amount);
    }

    // Sums all amounts and stores the result.
    // Inefficiencies: re-reads amounts.length every iteration (SLOAD in the
    // loop condition), reads the storage array element by element, post-increment,
    // no unchecked block for the loop counter, redundant zero-initialization.
    function computeTotal() public returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            sum = sum + amounts[i];
        }
        total = sum;
        return sum;
    }

    function count() public view returns (uint256) {
        return amounts.length;
    }
}
