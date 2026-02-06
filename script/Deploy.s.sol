// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/RiichiSettlementV1_1.sol";

contract Deploy is Script {
    function run() external returns (RiichiSettlementV1_1 deployed) {
        address verifier = vm.envAddress("VERIFIER");
        uint256 engineHash = vm.envUint("ENGINE_HASH");

        vm.startBroadcast();
        deployed = new RiichiSettlementV1_1(verifier, engineHash);
        vm.stopBroadcast();
    }
}
