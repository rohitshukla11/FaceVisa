# Schema: what FaceVisa puts on Arkiv

> The runs below wrote to earlier namespaces; those entities and their explorer links are unchanged. From
> 6 Nov the namespaces are `facevisa-dev`, `facevisa-public` and `facevisa-v1`.

Seven entity types, on Rabdi (chain 7794095). Each is a named schema `<namespace>.<type>`
([`agents/src/arkiv/schema.ts`](../agents/src/arkiv/schema.ts)), written with `@arkiv-network/sdk` 1.0.1.

## Namespaces

The namespace is `ARKIV_SCHEMA_PREFIX`, which is also each entity's `app` value.

| Namespace | Holds | Rules |
|---|---|---|
| `facevisa-public` | the public demo at https://facevisa.site, judge-facing | Google sign-in, labelled. Every entity here was written at the event (from 6 Nov), each ad paid in USDT on Whitechain. |
| `facevisa-dev` | development and the lifecycle runs | Anything, labelled by identity. Dev-only short lifetimes (minutes) are allowed only here. |
| `facevisa-v1` | real World ID data | Real World ID only: no stand-in, no DevConsent. Empty so far. |

A database is bound to the first namespace it writes to, and switching needs `pnpm reset-local`. So one namespace's
data never leaks into another.

**Every entity carries three indexed columns:**
- `app`: the namespace;
- `type`: listing, request, licence, receipt, revocation, creator_stats or brand_stats;
- `ref`: the outbox item that created it. A retry looks for owner + `ref` before creating anything, so nothing is
  created twice.

**Owners are custodial secp256k1 keys:** one per FaceVisa account, which FaceVisa holds in an encrypted keystore. Only
the owner can patch, extend or transfer an entity ([who can edit](how-you-use-arkiv.md#who-can-edit-each-entity)).

## The entities

| Entity | Owner | Created | Changed | Expires | Columns (**indexed**) |
|---|---|---|---|---|---|
| `listing` | the creator's key | when a creator lists | patched on any rule change; `status=unlisted` when they unlist | 30 days, extended back to 30 by an hourly sweep once under 15 days are left, while listed | **status**, **price** (u64, micro-USD per image; video is 3×), **max_days**, 10 × **banned_<category>** (bool), **display_name**, **has_capture**, **identity** |
| `request` | the brand's key | once the brand's agent has a finished ad for the creator to review | `status` (pending, approved, rejected, denied, cancelled, failed); `output_hash` for a new version | exactly the creator's review window (10 minutes by default), extended when a new version resets it | **brand** (addr), **creator** (addr), **kind**, brief_hash, **price**, **status**, **output_hash** |
| `licence` | the creator's key | at release: after the creator's fresh check and approval, and payment | `status=revoked` when the creator revokes | at the licence's end (at most 180 days) | **output_hash**, **brand**, **creator**, **usage**, kind, duration_days, price, approved_at, request_key, licence_id, **identity**, **status** |
| `receipt` | the platform receipt key `0x9625…00cA` | right after its licence | never: created **read-only** | `ExpirationTime.max()`: 7,884,000 blocks, ~182.5 days | **file_hash**, **licence_key** (key), **creator** (addr), licence_expires_at (u64, unix seconds), licence_id, provider, model, job_id, **generator** (0g, vertex, 0g+vertex, test), payment_ref (the Whitechain transaction hash), payment_rail (`whitechain` = USDT on Whitechain testnet; `dev` = a test payment, no money moved), payer (addr: the brand wallet that paid), face_check, face_score (thousandths), **world_id** (the creator's check at release: production, sandbox or none), world_id_credential (selfie or proof_of_human), swarm_ref (the ad file on Swarm: a plain 64-hex reference, never one that carries a key), swarm_encrypted (bool: true = Swarm holds ciphertext whose key is sealed to the brand and creator, off Arkiv) |
| `revocation` | the creator's key | when the creator revokes a licence | never: created **read-only** | `ExpirationTime.max()`, ~182.5 days: it outlives the licence entity | **licence_key** (key), **file_hash**, **creator** (addr), revoked_at (u64, unix seconds), licence_id |
| `creator_stats` | the creator's key | on their first listing or licence | patched whenever a number moves (listing, licence, payment, revoke, a licence ending); deleted by its owner once there's nothing left to count | 30 days, extended back to 30 once under 15 are left, while in use | **creator** (addr), **ads_approved**, **active_licences**, **revoked**, **earned_usdt** (USDT's smallest units, settled on Whitechain), **brands** (distinct), first_listed, **last_active** (u64, unix seconds) |
| `brand_stats` | the brand's account key | on its first licence | the same | the same | **brand** (addr), **ads_licensed**, **active_licences**, **spent_usdt**, **creators** (distinct), **last_active** |

Attributes per entity, counting the schema tag: listing 20, request 11, licence 16, receipt 20, revocation 9,
creator_stats 12, brand_stats 10 (the limit is 32).

**Stats are numbers, addresses and times only:** no names, briefs, prompts or sign-in details. They count what happened
in their namespace: licences and payments since the database was bound to it. A licence that ends lowers
`active_licences` at the next hourly sweep, which re-plans every live stats entity and writes only what changed.

**Request entities live only for the review window: 10 minutes by default** (`AGENT_PASS_REQUEST_TTL_MIN`). Their
explorer links stop resolving minutes after the creator decides. A brand's requests stay visible as transactions on
the brand's address page.

**The receipt carries the licence's creator and end.** That lets it answer on its own:
- whose licence it is: the licence's owner must be that `creator`;
- when the licence ended, once the licence entity has expired and Arkiv has deleted it. Verify then says "Licence
  expired on <date>", not "not found".

The earliest receipts lack these two columns; readers fall back to the licence's own `creator` column.

## The fields we query, and where

| Query | Conditions | Used by |
|---|---|---|
| Listings, all | `app`, `type=listing`, `status=listed` | the brand agent's shortlist |
| Listings that fit a brief | the above + `banned_<category> = false`, `max_days >= duration`, `price <= max` (a third of it for video) | the shortlist: picks and skips |
| A creator's inbox | `app`, `type=request`, `creator = <their address>`, `status=pending` | the creator's "Ads waiting for you" |
| A file's receipt | `app`, `type=receipt`, `file_hash = <sha256>`, `$owner = <receipt key>` | Verify, and the direct verifier |
| The creator's display name | `type=listing`, `$owner = <receipt.creator>` | Verify, and the direct verifier (only the creator's own listing counts) |
| Its revocation record, checked first | `type=revocation`, `licence_key = <receipt.licence_key>`, `$owner = <receipt.creator>` | Verify, and the direct verifier |
| Its licence | `$key = <receipt.licence_key>` | Verify, and the direct verifier |
| A creator's stats header | `type=creator_stats`, `$owner = <receipt.creator>` (only the creator's own entity counts) | the direct verifier and the public creator page |
| Creators with more than N approved ads | `type=creator_stats`, `ads_approved > u64(N)` | anyone: [runnable below](#query-the-stats-yourself) |
| Ads made on 0G, or by creators with a production World ID check | `type=receipt`, `generator = str('0g')` / `world_id = str('production')` | anyone |
| The file on Swarm | the receipt's `swarm_ref` (read with the receipt above) | Verify, the direct verifier, "On Swarm ↗" in the app ([swarm.md](swarm.md)) |
| Retry check | `ref = <outbox id>`, owned by the signer | before every create |

- The app's query builders are pure functions ([`agents/src/arkiv/reads.ts`](../agents/src/arkiv/reads.ts)).
- The direct verifier sends the same queries as raw JSON-RPC
  ([`web/public/verifier/verify.js`](../web/public/verifier/verify.js)).
- Each query costs 10 units of Arkiv's quota and takes about 310 ms (median) from our machine
  ([numbers](how-you-use-arkiv.md#numbers)).

## Query the stats yourself

Creators in the public demo with more than one approved ad, from Arkiv's public endpoint (no access key):

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = str('"'"'facevisa-public'"'"') AND type = str('"'"'creator_stats'"'"') AND ads_approved > u64(1)",{"select":{"key":true,"owner":true,"attributes":{"ads_approved":true,"active_licences":true,"revoked":true,"earned_usdt":true,"brands":true}},"limit":"0x14"}]}' \
  | jq '.result.data[] | {owner, stats: (.attributes | map({(.name): .value}) | add)}'
```

On 6 Nov at 18:23 UTC it returned one creator, owner `0xe668…36d9`: `ads_approved` 3, `active_licences` 3,
`revoked` 0, `earned_usdt` 250000 (0.25 USDT), `brands` 1 (u64 values come back as hex). Change `> u64(1)` to any N, or
query `type = str('brand_stats') AND spent_usdt > u64(100000)` for brands that spent more than 0.10 USDT.

## The live entities (`facevisa-public`)

The public demo at https://facevisa.site, read on Rabdi's explorer:

| Entity | What | Owner | Key |
|---|---|---|---|
| listing | Rohit, listed, with a World ID check (`presence = sandbox`) | Rohit's key `0xe668…36d9` | [0x14bc74f8…9e30](https://rabdi.explorer.arkiv.network/entity/0x14bc74f8b780cf1662151c6a362eab4686a60a0d8a6539df3b7aa980cfdb9e30) |
| licence | an image of Rohit, active, `lic_fde8f086a3de765e` | Rohit's key | [0xa2aca84c…c223](https://rabdi.explorer.arkiv.network/entity/0xa2aca84c0643a479cb7c970522c6e2173e486db1b6bcb0b01aac97eadc37c223) |
| licence | a video of Rohit, active, `lic_da1c80ad71a22bd1` | Rohit's key | [0x6b0f84c7…7b91](https://rabdi.explorer.arkiv.network/entity/0x6b0f84c75019a9b8bcf4d27f8444f5112e1eedefd7ca50364e8e0c16da917b91) |
| licence | the showcase image, active, `lic_8100bb9357f91ed6` | Rohit's key | [0xccc7e19a…8783](https://rabdi.explorer.arkiv.network/entity/0xccc7e19a701942ed3c83ca3bdd3cce3cc2bcd77b6a841973e1c8bc7506b68783) |
| receipt | the showcase image: paid in USDT on Whitechain, `swarm_ref` to the file on Swarm | the receipt key `0x9625…00ca` | [0x52ae1e9c…9e37](https://rabdi.explorer.arkiv.network/entity/0x52ae1e9ce8a5476e2169dae1216da9849e02f62c97f9632b2a62b3045f1f9e37) |
| receipt | the video: paid in USDT on Whitechain, `payer` the brand's wallet | the receipt key | [0xbbae0d93…6540](https://rabdi.explorer.arkiv.network/entity/0xbbae0d93008d5d28986d2bb93a71adcb39d2b8509b52cd7f7ee37478414c6540) |
| receipt | the first image: paid in USDT on Whitechain | the receipt key | [0x3764b04c…b240](https://rabdi.explorer.arkiv.network/entity/0x3764b04c5f623d66b46def6779b9f171ffe1a6fe374d736fdc8dfcbe0cb9b240) |
| creator_stats | Rohit: 3 ads approved, 3 active, 0.25 USDT earned, 1 brand | Rohit's key | [0x681f1d6e…c382](https://rabdi.explorer.arkiv.network/entity/0x681f1d6e82cba4416d2dbbd52e5020883b5e91d8759fe2c759ffdd024333c382) |
| brand_stats | Rohit's brand workspace: 3 ads licensed, 0.25 USDT spent | Rohit's key | [0xc431885e…796b](https://rabdi.explorer.arkiv.network/entity/0xc431885edcc148d0b3baadc443a1868d38b07d2c0fab35b82b9e0328c8f1796b) |

Asha and Daniel (synthetic demo creators) each have a listing and a `creator_stats` entity, owned by their own keys.

## Why these owners and lifetimes

- **Listing → creator.** It's their offer. Only their key changes it, and it stops existing a few weeks after they
  leave (30 days, renewed while listed), so a listing never outlives the creator's interest.
- **Request → brand.** It's the brand's ask. It lives exactly as long as the creator may review it, so an unanswered
  request disappears from the inbox by itself. An expired request is never patched (Arkiv can't patch it).
- **Licence → creator.** The creator grants it and only the creator can revoke it. It ends when the licence ends, so
  Arkiv, not our code, decides that it's over. That's why creators can allow at most 180 days: an entity lives at
  most ~182.5 days.
- **Revocation → creator, read-only.** It's the creator's own statement that they withdrew consent, in a record only
  they could have written. It never changes, and it lives the longest lifetime there is, so "Revoked on <date>"
  survives the licence entity.
- **Receipt → platform receipt key, read-only.** It records what FaceVisa released: file, licence, creator, licence
  end, model, payment. Nobody, FaceVisa included, can change it afterwards. It gets the longest lifetime there is, so
  it outlives the licence it backs.

## Why one boolean per category

The query language has no `!=` and no documented `NOT` ([friction.md](friction.md) #3). "Doesn't refuse Fitness" is
therefore `banned_fitness = false`, and every listing writes all ten booleans.
