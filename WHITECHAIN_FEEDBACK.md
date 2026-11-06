# Whitechain feedback

From building FaceVisa's USDT settlement on Whitechain Sepolia (chain 1874), 6 Nov 2026, at ETHGlobal Mumbai.
Each item says what we expected, what happened, and what would have helped.

## What worked well

- **USDT supports EIP-3009 (TetherTokenV2).** `receiveWithAuthorization` makes gasless payments for the brand
  simple: the brand signs once, and our relayer pays the gas. Tether requires `to == msg.sender`, so nobody can
  front-run a signed authorization. We found all this by reading the verified source on the explorer.
- **The RPC sends `Access-Control-Allow-Origin: *`.** Our public verifier checks `LicensePaid` straight from the
  browser, with no server of ours in between.
- **Blockscout verification by API.** `POST /api/v2/smart-contracts/{address}/verification/via/standard-input`
  verified FaceVisaSettlement within seconds of deploying it (deployed 08:40:19 UTC, verified 08:40:29 UTC).
- **Gas is cheap and steady:** about 5 gwei, so a `settle` costs a fraction of a cent.

## Friction

**1. How to get testnet USDT isn't in the docs.**
- Expected: a faucet, or a mint function on the testnet token, like Circle's faucet for testnet USDC.
- What we found:
  - [faucet.testnet.whitechain.io](https://faucet.testnet.whitechain.io) gives WBT only;
  - USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` has an owner-only `mint`;
  - the docs point to no DEX or bridge for testnet USDT.
- The answer, from the Whitechain team: swap WBT for USDT on [YetiTrade's testnet](https://testnet.yetitrade.fi/).
  USDT `0xcedfB561…f55a7` (6 decimals) is the only USDT that counts for the prizes.
- Effect: until we asked, a payment integration could be fully built and unit-tested, but the first real payment
  waited on a person at Whitechain.
- Would help: the YetiTrade link on the faucet page and in the docs, next to the USDT address and the note that it's
  the one that counts.

**2. The faucet needs a GitHub account older than 30 days.**
- The faucet gives 2 WBT a day per GitHub account, and the account must be more than 30 days old.
- 2 WBT a day covers a relayer comfortably (a settlement costs about 0.0007 WBT), but a newer GitHub account can't
  claim at all, and a team funding a relayer, an operator and a deployer on day one spreads claims across members.
- Would help: a hackathon tier, or a way in for newer accounts (e.g. a wallet signature plus a captcha).

**3. The RPC is slow: about 5 s per call.**
- viem's default timeouts (10 s, with retries) failed on calls that wait for several reads. We raised the timeout
  to 60–90 s.
- A payment that should feel instant takes 10–20 s end to end.
- Would help: a note in the docs on expected latency, or a second public RPC endpoint.

**4. Docs don't list token addresses or EIP-3009 support.**
- We found USDT's address, its EIP-712 domain (`{ name: "Tether USD", version: "1", chainId: 1874 }`) and its
  EIP-3009 functions by reading the proxy's implementation on the explorer.
- Would help: a "Tokens on testnet" page with addresses, decimals, domains and which permit/authorization standards
  each supports.

**5. Chain ID listed differently elsewhere.**
- Whitechain's own docs say chain 1874. A third-party chain list (Sequence's) shows Whitechain testnet as 2625.
- Would help: one canonical network page that other lists can link to.

## What we built

- [`contracts/src/FaceVisaSettlement.sol`](contracts/src/FaceVisaSettlement.sol),
  [`0x8fbbca9e637c6261386e38dfef016a7dd90fc65b`](https://explorer.testnet.whitechain.io/address/0x8fbbca9e637c6261386e38dfef016a7dd90fc65b).
- The payment rail: [`agents/src/whitechain/whitechain.ts`](agents/src/whitechain/whitechain.ts).
- The browser check: [`web/public/verifier/verify.js`](web/public/verifier/verify.js).
- Details: the [README's Whitechain section](README.md#whitechain-usdt-payments-nobody-notices).
