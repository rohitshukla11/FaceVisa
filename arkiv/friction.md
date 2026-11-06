# Arkiv friction log

> The runs below wrote to earlier namespaces; those entities and their explorer links are unchanged. From
> 6 Nov the namespaces are `facevisa-dev`, `facevisa-public` and `facevisa-v1`.

Real times, written when it happened. Each entry: what we expected, what happened, how to reproduce.

## Reading the docs

**1. The Hub's pages carry no content without JavaScript.**
- Expected: `hub.arkiv.network/ai-tools`, `/access-keys` and `/faucet` to say how to install the AI tools, how keys
  work, and how much a faucet claim gives.
- Actual: a non-JavaScript fetch returns only headings and "Loading…". The AI tools page names four tools ("Arkiv AI
  plugin", "MCP", "Skills", "npm Tools") with no install commands or links. The install steps are in GitHub READMEs
  (`Arkiv-Network/ai-plugin`, `Arkiv-Network/skills`), which we found by guessing repository names.
- Still unknown: the faucet amount per claim and its cooldown ("One claim per wallet, per cooldown window"), and the
  gas cost of a write.
- Reproduce: `curl -s https://hub.arkiv.network/ai-tools | grep -c "claude plugin"` prints 0.

**2. Two sources disagree on whether the access key is a secret.**
- The SDK (`src/chains/rabdi.ts`, 1.0.1): "It is not a secret, as it ships with any app that talks to the chain, but
  restrict it to your origins or IPs."
- The docs (`/start-here/access-keys/`): "A key isn't a password, but anyone who has it can spend your quota."
- We treat it as a secret: server-side only, never logged. The SDK puts it in the RPC URL path, so we never log RPC
  URLs or raw SDK errors.

**3. The query language has no documented negation.**
- The query language reference lists `NOT` as a reserved keyword but doesn't document it, and there's no `!=`.
- So "creator hasn't banned this category" is written as `banned_<category> = false`. That only works if every
  listing writes every category's boolean.

**4. A licence can be longer than an entity can live.**
- The limits page: "Lifetime, from the block the create or extension lands in": 7,884,000 blocks, "about 182.5
  days".
- FaceVisa lets creators allow licences of up to 365 days (`MAX_DAYS_LIMIT`), so a licence entity can't be created
  with its full lifetime.

## Building the client and outbox

**4. The SDK's public client can't price or estimate a write, which the write-safety guide requires.**
- Expected: `createPublicClient(...)` from `@arkiv-network/sdk` to offer viem's `getGasPrice` and `estimateGas`: the
  `arkiv-write-safety` guide asks for "current `eth_gasPrice`" and an "exact unsigned `eth_estimateGas`" before every
  signature.
- Actual: `PublicArkivClient` has neither (TypeScript: "Property 'getGasPrice' does not exist"). We call viem's
  actions on it instead: `getGasPrice(client)` and `estimateGas(client, …)` from `viem/actions`.
- Reproduce: `createPublicClient({ chain: rabdi({ accessKey: "" }), transport: http() }).getGasPrice()` fails to compile.

**5. There's no way to see a write's transaction hash before the SDK waits for its receipt.**
- Expected: a way to store the hash before broadcast, as the write-safety guide asks ("Preserve every known hash
  immediately").
- Actual: `createEntity`, `patchEntity` and `executeBatch` sign, send and wait in one call; the hash comes back only
  with the receipt (or inside `EntityMutationError`, sometimes not at all). We wrap the viem transport: on
  `eth_sendRawTransaction` it checks the signed gas against a fresh estimate, stores `keccak256(raw)` and only then
  forwards it (`agents/src/arkiv/chain.ts`).
- Reproduce: read `src/utils/arkivTransactions.ts` in SDK 1.0.1: `writeContract` then `waitForTransactionReceipt`, no
  hook in between.

**6. The SDK we needed was a days-old release: the MCP pins 1.0.0, the guides describe 1.0.1.**
- The Arkiv MCP's `network_status` gives `npm install @arkiv-network/sdk@1.0.0 viem` (integrity-verified), while the
  write-safety guide documents 1.0.1 behaviour (out-of-gas diagnostics, the lifetime check before sending). 1.0.1 came
  out a day before we installed it, so our pnpm release-age policy needed an exception for it.
- We use 1.0.1: it refuses a lifetime past 7,884,000 blocks before sending, instead of a paid `ExpiryBeyondMaxLifetime`
  revert.
- Needed a days-old release: `pnpm add @arkiv-network/sdk@1.0.1 --save-exact` wrote a `minimumReleaseAgeExclude` entry for
  that exact version into `agents/pnpm-workspace.yaml`, because the release was younger than our policy's minimum age.
  Rohit approved the one-version exception. A stable SDK would avoid it: the fix we depend on shipped two days
  after 1.0.0, and four days before the event.
- Reproduce: `npm view @arkiv-network/sdk time --json` shows when each version was published: 1.0.1 came out three days after 1.0.0.

**Measured on Rabdi** (not friction, but missing from the docs): one listing create with 20 attributes used 313,944
gas and one single-column patch 52,419, at a gas price of 1 gwei (0.000314 and 0.000052 tGLM). A create was confirmed
in ~5 s. Transactions: `0xa5b1e8f5a624bead1fa7f648752f10b845c530fbc433bbd7f1327034b0dd5547` (create) and
`0x66e1b13a5191f7b5c9474a56cf28c7ac9f3eb76a308d249f4fa78defc6b41474` (patch), in the throwaway namespace
`facevisa-smoke`.

## The direct verifier and the lifecycle on Rabdi

**7. Query results give expiry as a block number, never a time.**
- Expected: `expiresAt` as a timestamp, or next to one, so a page can say "until 7 Dec, 09:01".
- Actual: `expiresAt` is a block number (`"0x700a6"`). Turning it into a time takes a second call,
  `arkiv_getBlockTiming`, which gives `{ current_block, current_block_time, duration }`. A browser verifier pays that
  extra request on every check.
- Reproduce: `curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d
  '{"jsonrpc":"2.0","id":1,"method":"arkiv_getBlockTiming","params":[]}'`.

**8. An expired entity leaves no trace, so its last state is lost.**
- Expected: some way to learn that an entity existed and how it ended (a tombstone, or a "was revoked" state).
- Actual: at expiry the entity is deleted and queries return nothing. A licence that was revoked and then reached
  its end looked, on Arkiv, exactly like one that simply ended.
- Our workaround:
  - On revoke, the creator's key also writes a read-only **revocation** entity: the licence's entity key, the file
    hash and `revoked_at`, with the longest lifetime there is.
  - Both readers check it first, owned by the creator the receipt names, so a revoked licence reads "Revoked on
    <date>" after its licence entity has gone. That was checked live in `facevisa-dev`.
  - The receipt also carries the licence's end, for "Licence expired on <date>".
  - The cost: an extra entity and a create per revocation, and a record that itself expires after ~182.5 days.
- What would close it: a queryable record of deleted entities (key, owner, end block, final attributes).
- Reproduce: revoke a short-lived licence, let it expire, then query its `$key`: no rows.

**9. The public endpoint works from a browser, but its limits aren't documented where builders look.**
- Good: `OPTIONS` answers `access-control-allow-origin: *` and allows `Content-Type, Authorization, X-Api-Key`, so a
  static page can query Arkiv directly.
- Observed but undocumented:
  - each response carries `RateLimit: limit=2000, remaining=…, reset=10` and `Arkiv-Cost: 10` for a query;
  - nothing says what the units are or whether the limit is per IP. We assume per IP, 2,000 units per 10 s, 10 per
    query.
- Reproduce: `curl -si https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d
  '{"jsonrpc":"2.0","id":1,"method":"arkiv_getBlockTiming","params":[]}' | grep -i ratelimit`.

**10. Expiry can't be shortened, so testing it takes new entities.**
- Expected: a way to make an existing test entity expire soon.
- Actual: an extension counts from now and "can't move the expiry earlier". To watch renewal and expiry in minutes,
  we added dev-only settings (`ARKIV_DEV_LICENCE_MINUTES`, `ARKIV_DEV_LISTING_MINUTES`, refused outside
  `facevisa-dev`) and made new entities with short lifetimes.

## Stats entities, Swarm references and the public demo

**11. There's no SUM or COUNT across entities, so we keep our own running totals on Arkiv.**
- Expected: to answer "how many ads has this creator approved, and how much have they earned?" with one query over
  their licences and receipts.
- Actual: a query returns entities, not aggregates. We added two entity types, `creator_stats` and `brand_stats`, and
  patch their counters on every release, revoke and payment, plus an hourly sweep to lower `active_licences` as
  licences end. It works and is queryable (`ads_approved > u64(N)`), but every counter is ours to keep right, and a
  reader has to trust that the owner's numbers match the receipts.
- Would help: `count` and `sum` over a filtered set (even limited to indexed numeric columns), so totals are derived
  from the records themselves.

**12. The page-size limit is found by hitting it.**
- Expected: the maximum `limit` per query in the docs or the SDK's types.
- Actual: the node answers `{"code":-32602,"message":"limit 101 exceeds the node maximum of 100"}`. Clear, but only
  after the request; we had written `0x200` to scan a namespace.
- Reproduce: any `arkiv_query` with `"limit":"0x65"` on `https://rpc.rabdi.db-chain.testnet.arkiv.network`.
- Would help: the maximum on the query docs page, and a constant exported by the SDK.

**13. Raw RPC results use different encodings for different column types.**
- Actual: `u64` values come back as hex strings (`"ads_approved":"0x3"`, `"earned_usdt":"0x3d090"`), booleans as JSON
  `true`/`false`, strings and addresses as strings. Our browser verifier, which speaks raw JSON-RPC, converts each
  type by hand.
- Reproduce: the stats query in [schema.md](schema.md#query-the-stats-yourself).
- Would help: one line in the JSON-RPC docs listing how each column type is encoded in results.

**14. Adding a column to a live schema needs care, and nothing says how.**
- What we did: new optional columns on the receipt (`payer`, `generator`, `world_id`, `swarm_ref`, …) while older
  receipts without them stay live in the same namespace. Optional columns made this work, and old receipts simply
  lack the fields; readers fall back.
- What we couldn't find: guidance on evolving a named schema (adding, never removing; what happens to a typed read
  when an older entity lacks a column; whether to version the schema name).
- Would help: a short "changing a schema" page.

**15. Swarm references and Arkiv: the safe pattern isn't written down.**
- Swarm's encrypted references (128 hex digits) carry their decryption key, and Arkiv entities are public, so storing
  one on an entity publishes the key. We encrypt files ourselves (AES-256-GCM, the key sealed to the brand and the
  creator) and store only the plain 64-hex reference, refusing anything longer ([swarm.md](swarm.md)).
- Would help: this warning, and the pattern, on Arkiv's large-files or encryption page, since "point to the file
  from an entity" is the natural design.
