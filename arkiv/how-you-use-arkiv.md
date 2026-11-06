# How FaceVisa uses Arkiv

> The runs below wrote to earlier namespaces; those entities and their explorer links are unchanged. From
> 6 Nov the namespaces are `facevisa-dev`, `facevisa-public` and `facevisa-v1`.

FaceVisa lets a brand's AI agent ask to use a creator's face in an ad. Nothing is released until the creator approves
the finished ad with a fresh check of their own. Arkiv holds the public side of that deal:
- who offers what: **listings**;
- who asked: **requests**;
- what was granted: **licences**;
- what was released: **receipts**.

SQLite stays the authority, and Arkiv mirrors its public state after each commit. Three screens in the app read from
Arkiv, and a fourth page reads nothing else: the direct verifier, a static page that asks Arkiv from the visitor's
browser.

## Does each Arkiv feature change something users see?

| Arkiv feature | Where users see it |
|---|---|
| **Indexed numeric filters** (`price <= max`, `max_days >= duration`) | The brand agent's shortlist. A creator is picked only if their listing entity is in Arkiv's query of listings that fit the brief. The skip reason ("doesn't allow Alcohol", "licenses 14 days at most") is read from the entity's own columns. |
| **Boolean filters** (`banned_<category> = false`) | The same shortlist: a creator who refuses the category is skipped. |
| **Owner-scoped queries** (`$owner = addr(…)`) | Verify and the direct verifier accept only a receipt owned by FaceVisa's published receipt address, and a licence owned by the creator the receipt names. An entity anyone else writes into our namespace fails the check ("not trusted"), or is ignored and counted in the shortlist's label. |
| **Patch** | Revoking a licence patches `status=revoked`; Verify and the direct verifier say Revoked, read from Arkiv. Unlisting patches `status=unlisted`, and the shortlist's query stops returning that creator. |
| **Extension** (`extendEntity`) | A listed creator stays findable. The listing is renewed once it has less than half its lifetime left, and the creator's dashboard shows when ("renewed automatically, next from <date>"). An unlisted creator's listing is left to expire. |
| **Expiration** | The creator's inbox: a request entity lives exactly the review window, so an unanswered request just disappears, and its "review by" time is the entity's expiry. A licence entity expires at the licence's end; Verify and the direct verifier then say "Licence expired on <date>", from the receipt. |
| **Read-only entities** | Receipts can't be edited by anyone, FaceVisa included. Verify shows "owned by the FaceVisa receipt key ✓". The receipt also states how the file was made (model, face check and score) and the payment: rail `whitechain` with the USDT settlement's transaction hash as `payment_ref` and the paying wallet as `payer`, which the direct verifier checks on Whitechain's RPC (`LicensePaid`, from the browser). A DevPayment shows as "test payment (no money moved)", the way a stand-in identity shows as a test identity. |
| **Owner-scoped name lookup** | The creator's display name next to their address, read from their own listing entity (`$owner` = the creator the receipt names). A listing written by any other key is ignored; if the listing is gone, the address shows alone. |
| **A revocation record, owned by the creator** | On revoke, the creator's key also writes a read-only `revocation` entity (licence key, file hash, `revoked_at`, maximum lifetime). Verify and the direct verifier check it first, so a revoked licence reads "Revoked on <date>" even after its licence entity has expired. |
| **Public JSON-RPC, CORS `*`** | The direct verifier (`/verifier/index.html`) runs entirely in the browser against Arkiv's public endpoint: no FaceVisa server, no access key. |
| **Entity links** | Licences, Verify, the request page and the direct verifier link each entity to the Rabdi explorer. |
| **Indexed counters** (`creator_stats`, `brand_stats`) | The public creator page and the direct verifier open with the creator's numbers (ads approved, active licences, revoked, earned in USDT, brands, listed since, last active), read from the creator's own stats entity. In the app, every creator card on the Creators page and the brand agent's shortlist shows the same numbers with "Stats on Arkiv ↗", and the creator's dashboard links "your stats entity ↗". Anyone can rank creators by them: `ads_approved > u64(N)` ([schema](schema.md#query-the-stats-yourself)). |
| **Patch, extension and delete on running numbers** | Each release, revoke or payment patches only the counters that moved; the hourly sweep lowers `active_licences` as licences end and renews the 30-day lifetime; an entity with nothing left to count is deleted by its own owner. |
| **A pointer to the file on Swarm** (`swarm_ref`, `swarm_encrypted` on the read-only receipt) | Verify and the direct verifier fetch a showcase ad from Swarm's gateway and show "On Swarm ✓ same bytes as this file"; every ad in the app has "On Swarm ↗". Private ads are encrypted before upload, so the public reference reveals nothing ([swarm.md](swarm.md)). |
| **Indexed receipt facts** | `generator` (0g, vertex) and `world_id` (production, sandbox, none) on each receipt: "ads made on 0G" or "ads of creators with a production World ID check" is one query. |

Every screen also says where its data came from:
- "Read from Arkiv (facevisa-public)";
- or "From FaceVisa, not yet confirmed on Arkiv: <why>", when a write is still pending or Arkiv can't be reached (a
  6 s timeout). Arkiv being down never blocks the product.

## Do the filters, editing rights and expiries fit what the app does?

**Filters.**
- The shortlist filters on exactly what a brand asks: category, duration and price.
- Verify looks up a file by its sha256, then its licence by entity key.
- The inbox filters on the creator's address and `status=pending`.
- All of these are indexed. Columns that are only displayed (brief_hash, licence_id, model) aren't.

### Who can edit each entity

- **Listing:** the creator's key.
- **Request:** the brand's key, which also moves its status.
- **Licence:** the creator's key, so only the creator can revoke.
- **Receipt:** nobody (read-only).
- **Creator stats:** the creator's key. **Brand stats:** the brand's account key. FaceVisa's outbox writes them with
  those keys (custodial, below), and readers accept only the subject's own entity.

**Ownership is custodial today.** FaceVisa generates one secp256k1 key per account and holds it in an encrypted
keystore (scrypt + AES-256-GCM). The creator therefore can't sign anything themselves yet. The path to self-custody is
Arkiv's `changeOwnership`:
1. The creator gives a wallet address.
2. Their custodial key transfers their listing and licences to it.
3. Readers then accept that wallet as the owner.

Today, our readers accept the creator address the receipt names; a transferred licence would need the creator's
declared wallet instead. FaceVisa doesn't offer this yet.

**Expiry.** Each entity lives as long as the thing it describes:
- a listing while listed;
- a request for its review window;
- a licence for its term, capped at 180 days so Arkiv can enforce it;
- a receipt for the maximum (~182.5 days);
- stats for 30 days, renewed while in use, deleted when there's nothing left to count.

Nothing relies on our own cron to end anything. One consequence:
- Arkiv deletes an expired entity, so a revoked licence's own entity can't say "revoked" after its end. The creator's
  read-only **revocation** record (maximum lifetime) does: both readers check it first ([friction](friction.md) #8).
- **Request entities live only for the review window: 10 minutes by default** (`AGENT_PASS_REQUEST_TTL_MIN`), or until
  a new version resets it. A request's explorer link stops resolving minutes after the creator decides. To see a
  brand's requests afterwards, use the brand's address page in the explorer: it lists the transactions that created
  and patched them.

## Live on Rabdi

### The public demo (`facevisa-public`)

Every ad released on https://facevisa.site, checked by the public verifier (Arkiv, Whitechain's RPC and Swarm's
gateway, from the browser; no FaceVisa server):

| File | Deal | Direct verifier |
|---|---|---|
| `0x26455bd9…2c3d` | an image of Rohit, licensed by his brand workspace | Licensed; payment confirmed on Whitechain ([`0x632ec6d3…2d9e`](https://explorer.testnet.whitechain.io/tx/0x632ec6d388829fb964e23035e083538834e29c41c537cc3d7ce3960592c92d9e)) |
| `0x680a9dde…fd0b` | a video of Rohit | Licensed; payment confirmed ([`0xceff7eb5…7ae3`](https://explorer.testnet.whitechain.io/tx/0xceff7eb54e2f5a341f5f2448fbfe8366b852825eb8ae87a484999c22c0367ae3)), from the brand's own wallet (`payer`) |
| `0x45b8257f…a220` | the showcase image | Licensed; payment confirmed ([`0x1508d442…8432`](https://explorer.testnet.whitechain.io/tx/0x1508d44255adce49f1e7b108f141f9bbfbbc5f1d4e5d27f1175238af37dc8432)); On Swarm ✓ same bytes as this file |

The entities and their links are in [schema.md](schema.md#the-live-entities-facevisa-public).

### The lifecycle (`facevisa-dev`)

Run by `pnpm arkiv:lifecycle` with the dev-only short lifetimes (licences 4
minutes, listings 6 minutes) and the synthetic dev creator. Every step was read back through FaceVisa's Verify and
through the direct verifier:
1. **Two licences released:** both Licensed, through both readers, with every ownership check passing.
2. **Revoke:** the creator's key patched `status=revoked`. Both readers said Revoked (FaceVisa's Verify reading it
   from Arkiv).
3. **Renewal:** the sweep extended the listing at half its life. Its expiry block went from 198494 to 198584, and the
   dashboard's "renewed from" moved with it.
4. **Unlist, then list again:** the listing left Arkiv's `status=listed` query and the brand's shortlist, then came
   back.
5. **Expiry:** licence A's entity reached its end (08:59:55) and was gone from queries about a minute later. Its
   receipt remained. FaceVisa's Verify (read from Arkiv) and the direct verifier both said "Licence expired on <date>".
   - Receipt: [0xfb25f324…5d9e](https://rabdi.explorer.arkiv.network/entity/0xfb25f324372a9a8810180fe9ed84f7a9ccf07d8259b2060f0f5c163be0c55d9e).
6. **Revoked, then expired** (the 09:27 run): licence B was revoked at 09:28:20 and its entity expired at its end.
   Both readers still said "Revoked on <date>", from the creator's revocation record:
   - [0xd4060a4f…ec7c](https://rabdi.explorer.arkiv.network/entity/0xd4060a4f192b1523213a90a2dcad9f1f33b39abcaaa8aee2453952a2c54dec7c).

## Numbers

Measured on Rabdi (`pnpm arkiv:metrics`).

**Gas used per write.** Gas price is 1 gwei, so 100,000 gas = 0.0001 tGLM.

| Write | Gas used (median) | Samples |
|---|---|---|
| listing create (20 attributes) | 377,000–405,000 | 4 |
| request create | 190,068 | 10 |
| licence create | 223,129 (dev: 220,993) | 10 |
| receipt create (13 attributes, read-only) | 553,054 (dev: 550,328) | 10 |
| a patch: status, price, or status + extension | 42,889–55,440 | 15 |
| top-up of an account key (native transfer) | 21,000 | 7 |

**Entities written.**
- the demo namespace: 10 (2 listings, 3 requests, 2 licences, 2 receipts, 1 revocation), plus top-ups for 3 new
  account keys. The requests have since expired, as designed.
- `facevisa-dev`: 25 at the time, in 44 transactions.

**Query latency.** Each user-facing query, from our machine in India to Rabdi's public endpoint, 10 runs:
- median 306–320 ms, p90 under 530 ms;
- the same with or without an access key;
- a check in the direct verifier is 3 requests, about 1–1.6 s in all.

**Write latency.**
- Signed to confirmed: 4.3–5.7 s (2–3 blocks of 2 s).
- Committed to confirmed: 7–51 s. One worker sends one write at a time, and a new account key first waits for its
  top-up.

## How writes stay correct

The outbox is in [`agents/src/arkiv/outbox.ts`](../agents/src/arkiv/outbox.ts).
- **Only the difference is written.** Each change queues "bring this record's entity up to date". The worker compares
  what the entity should hold with what it last wrote, then sends a create, a patch of only the changed columns, an
  extension, or nothing. A request denied, or a licence revoked, before its first write still goes on Arkiv as it is.
- **Each transaction's hash is stored before it is sent** (a wrapped transport). An error before that point means
  nothing was sent, so the outbox retries with backoff. After it, the outcome is settled from the receipt, never by
  sending again.
- **Gas** is the larger of 1,000,000 (plus 400,000 per extra operation) and 2 × an estimate of the exact signed call.
  It's capped at half a block, with a fresh nonce and the current gas price, following Arkiv's write-safety guide.
- **Funding.** A funder key tops up an account key with 0.05 tGLM before its first write (about 200 writes' worth),
  capped per key and per day.
