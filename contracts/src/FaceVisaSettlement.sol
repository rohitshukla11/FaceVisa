// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The two calls FaceVisa needs from Whitechain's USDT (TetherTokenV2: EIP-3009 and ERC-20).
interface IUSDT {
    /// EIP-3009, signature as bytes. Tether requires `to == msg.sender`, so only the payee can submit it: nobody can
    /// front-run a brand's signed authorization.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * @title FaceVisaSettlement
 * @notice Pays a creator for one licensed ad, in Whitechain USDT, gaslessly for the brand.
 *
 * The brand's custodial key signs an EIP-3009 ReceiveWithAuthorization (from the brand, to this contract) after the
 * creator approved the exact ad in FaceVisa. FaceVisa's relayer submits `settle` and pays the gas in WBT. This contract
 * pulls the USDT from the brand, forwards it to the creator in the same transaction, and emits `LicensePaid`.
 *
 * The authorization is bound to the licence: its nonce is `nonceFor(licenceId, fileHash, creator, amount)`, recomputed
 * here, so a signature can't pay another licence, another file, another creator or another amount. Tether's own nonce
 * check makes it single use, and `paid[licenceId]` stops a licence being paid twice.
 *
 * What stops draining: only the relayer can call `settle`; the relayer never holds USDT (it only pays gas); every
 * payment is capped (`maxPerPayment`) and so is the day's total (`maxPerDay`); the owner can pause. Fees aren't
 * refunded after release: revoking a licence stops future use.
 */
contract FaceVisaSettlement {
    /// One licence's payment: who pays whom, how much, for which file, and the authorization's validity window.
    struct Payment {
        string licenceId;
        bytes32 fileHash;
        address brand;
        address creator;
        uint256 amount;
        uint256 validAfter;
        uint256 validBefore;
    }

    IUSDT public immutable usdt;
    address public owner;
    address public relayer;
    /// USDT's smallest units (6 decimals).
    uint256 public maxPerPayment;
    uint256 public maxPerDay;
    bool public paused;
    /// UTC day number (block.timestamp / 1 days) => USDT settled that day.
    mapping(uint256 => uint256) public settledOnDay;
    /// keccak256(licenceId) => paid.
    mapping(bytes32 => bool) public paid;

    event LicensePaid(bytes32 indexed fileHash, string licenceId, address indexed creator, address indexed brand, uint256 amount);
    event RelayerChanged(address relayer);
    event CapsChanged(uint256 maxPerPayment, uint256 maxPerDay);
    event PausedChanged(bool paused);
    event OwnerChanged(address owner);

    error NotOwner();
    error NotRelayer();
    error IsPaused();
    error BadParty();
    error BadAmount();
    error OverPaymentCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 settled, uint256 cap);
    error AlreadyPaid(string licenceId);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IUSDT usdt_, address relayer_, uint256 maxPerPayment_, uint256 maxPerDay_) {
        usdt = usdt_;
        owner = msg.sender;
        relayer = relayer_;
        maxPerPayment = maxPerPayment_;
        maxPerDay = maxPerDay_;
        emit OwnerChanged(msg.sender);
        emit RelayerChanged(relayer_);
        emit CapsChanged(maxPerPayment_, maxPerDay_);
    }

    /// The EIP-3009 nonce that binds an authorization to one licence of one file, to one creator, for one amount.
    function nonceFor(string calldata licenceId, bytes32 fileHash, address creator, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(bytes(licenceId)), fileHash, creator, amount));
    }

    /// Pays `p.creator` `p.amount` USDT from `p.brand`, with the brand's signed authorization. Relayer only.
    function settle(Payment calldata p, bytes calldata signature) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (paused) revert IsPaused();
        _check(p);
        usdt.receiveWithAuthorization(p.brand, address(this), p.amount, p.validAfter, p.validBefore, nonceFor(p.licenceId, p.fileHash, p.creator, p.amount), signature);
        if (!usdt.transfer(p.creator, p.amount)) revert TransferFailed();
        emit LicensePaid(p.fileHash, p.licenceId, p.creator, p.brand, p.amount);
    }

    /// The parties, the caps (per payment, per UTC day) and once per licence; records the day's total and the licence.
    function _check(Payment calldata p) private {
        if (p.brand == address(0) || p.creator == address(0) || p.creator == address(this) || p.creator == p.brand) revert BadParty();
        if (p.amount == 0) revert BadAmount();
        if (p.amount > maxPerPayment) revert OverPaymentCap(p.amount, maxPerPayment);
        uint256 day = block.timestamp / 1 days;
        uint256 total = settledOnDay[day] + p.amount;
        if (total > maxPerDay) revert OverDailyCap(total, maxPerDay);
        bytes32 key = keccak256(bytes(p.licenceId));
        if (paid[key]) revert AlreadyPaid(p.licenceId);
        settledOnDay[day] = total;
        paid[key] = true;
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerChanged(relayer_);
    }

    function setCaps(uint256 maxPerPayment_, uint256 maxPerDay_) external onlyOwner {
        maxPerPayment = maxPerPayment_;
        maxPerDay = maxPerDay_;
        emit CapsChanged(maxPerPayment_, maxPerDay_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedChanged(paused_);
    }

    function setOwner(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert BadParty();
        owner = owner_;
        emit OwnerChanged(owner_);
    }
}
