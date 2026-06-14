// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice Deploys TestUSDC and mints an initial supply to RECIPIENT.
/// Env:
///   RECIPIENT     - address to mint to (defaults to the hackathon wallet)
///   MINT_AMOUNT   - whole tokens to mint (defaults to 1_000_000)
contract DeployTestUSDC is Script {
    function run() external {
        address recipient = vm.envOr("RECIPIENT", address(0xC36Ef4e05F18Cc04Ae44E0035a2c344a634b4FA5));
        uint256 mintWhole = vm.envOr("MINT_AMOUNT", uint256(1_000_000));

        vm.startBroadcast();

        TestUSDC token = new TestUSDC();
        uint256 amount = mintWhole * (10 ** token.decimals());
        token.mint(recipient, amount);

        vm.stopBroadcast();

        console.log("TestUSDC deployed at:", address(token));
        console.log("Owner (admin):       ", token.owner());
        console.log("Minted to:           ", recipient);
        console.log("Amount (raw):        ", amount);
        console.log("Recipient balance:   ", token.balanceOf(recipient));
    }
}
