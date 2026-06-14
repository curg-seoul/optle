// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title TestUSDC
/// @notice A test/dummy USDC token for Mantle Sepolia. The deployer (msg.sender)
///         is registered as the admin (owner) and can mint any amount to any
///         address. Implements EIP-3009 (transferWithAuthorization /
///         receiveWithAuthorization / cancelAuthorization) so it works with the
///         x402 `exact` payment scheme's gasless authorized transfers.
/// @dev EIP-712 domain version is "2" to match real USDC (and the server's
///      PAYMENT_EIP712_VERSION=2). Decimals are 6, like USDC.
contract TestUSDC is ERC20, Ownable, EIP712 {
    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    /// @dev authorizer => nonce => used. EIP-3009 uses random (non-sequential) nonces.
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    constructor()
        ERC20("USD Coin", "USDC")
        Ownable(msg.sender)
        EIP712("USD Coin", "2")
    {}

    /// @notice USDC uses 6 decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Admin-only mint. The owner (deployer) can mint any amount to anyone.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Returns whether an authorization nonce has been used or canceled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice EIP-3009: execute a transfer with a signed authorization.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        _verifySignature(from, structHash, v, r, s);
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice EIP-3009: like transferWithAuthorization but `to` must be msg.sender,
    ///         preventing front-running of the relayed transfer.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "TestUSDC: caller must be the payee");
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        _verifySignature(from, structHash, v, r, s);
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice EIP-3009: cancel an unused authorization.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(!_authorizationStates[authorizer][nonce], "TestUSDC: authorization is used or canceled");
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _verifySignature(authorizer, structHash, v, r, s);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireValidAuthorization(
        address authorizer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore
    ) private view {
        require(block.timestamp > validAfter, "TestUSDC: authorization is not yet valid");
        require(block.timestamp < validBefore, "TestUSDC: authorization is expired");
        require(!_authorizationStates[authorizer][nonce], "TestUSDC: authorization is used or canceled");
    }

    function _verifySignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s)
        private
        view
    {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, v, r, s);
        require(recovered == signer, "TestUSDC: invalid signature");
    }

    function _markAuthorizationUsed(address authorizer, bytes32 nonce) private {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
