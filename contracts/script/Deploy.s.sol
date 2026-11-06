// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {FaceVisaSettlement, IUSDT} from "../src/FaceVisaSettlement.sol";

/// Deploys FaceVisaSettlement with Whitechain's USDT, the relayer, and the caps (USDT has 6 decimals):
///   WHITECHAIN_USDT, WHITECHAIN_RELAYER, SETTLEMENT_MAX_PER_PAYMENT (default 1 USDT), SETTLEMENT_MAX_PER_DAY (default 20 USDT)
contract Deploy is Script {
    function run() external returns (FaceVisaSettlement s) {
        address usdt = vm.envOr("WHITECHAIN_USDT", address(0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7));
        address relayer = vm.envAddress("WHITECHAIN_RELAYER");
        uint256 perPayment = vm.envOr("SETTLEMENT_MAX_PER_PAYMENT", uint256(1_000_000));
        uint256 perDay = vm.envOr("SETTLEMENT_MAX_PER_DAY", uint256(20_000_000));
        vm.startBroadcast();
        s = new FaceVisaSettlement(IUSDT(usdt), relayer, perPayment, perDay);
        vm.stopBroadcast();
        console2.log("FaceVisaSettlement", address(s));
    }
}
