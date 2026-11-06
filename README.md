# FaceVisa

**License your face to AI. Only you approve each ad.**

"Agents negotiate. Only the human consents to their face being used."

A brand's AI agent finds creators within their rules and makes the ad. Nothing is released until the creator sees
the finished ad and approves it in FaceVisa. Spends over the brand's limit also need the brand's own approval.
Before a creator is listed at all, World ID's IDKit checks they're a real person, once per World ID. Anyone can verify
a file afterwards.

> **World ID: submitted to "Best Use of IDKit".** A creator proves they're a real person, present, once per World
> ID, before their face is listed for paid licensing: Proof of Presence (World ID's Selfie Check) through IDKit 4,
> or Proof of Human for creators who already hold it ([below](#world-id-idkit-proof-of-presence-before-a-face-is-listed)).
> - **World ID appears in one place: the IDKit check** before a creator lists their face and, on the public demo,
>   before a brand's agent shortlists or requests ads. Sign-in (Google on the public demo, a dev sign-in locally) and
>   approvals don't use World ID. Approvals are in-app: the signed-in creator approves the exact ad, and the brand
>   approves a big spend. Agent Pass is dropped; its code is archived (`agents/archive/`), and World ID sign-in stays
>   behind `WORLDID_SIGNIN=1`, off by default.
> - **First real verification: 5 Nov 2026, 17:34 UTC, in World ID's sandbox.** It was a Proof of Human from the
>   sandbox World ID app, checked by our server and World's verify endpoint ("Proof verified successfully").
>   - The sandbox can't do the Selfie Check yet: it's listed as "Coming soon", and the app stalls on any request
>     that includes it. So sandbox requests ask for Proof of Human alone.
>   - The production World App offered only the Orb for our request.
>   - Every sandbox proof is labelled "World ID sandbox", never as production verification.
>   - Times and World's answers: [INTEGRATION_DEBRIEF.md](INTEGRATION_DEBRIEF.md#idkit).
> - Test identities are labelled `dev` (local) or `demo` (the public demo) on every screen, receipt, audit message and
>   Arkiv entity.

Built at ETHGlobal Mumbai (5–7 Nov 2026). Integration log with real timestamps: [INTEGRATION_DEBRIEF.md](INTEGRATION_DEBRIEF.md).

**Try it:** https://facevisa.site (testnet; sign in with Google). Repo: https://github.com/rohitshukla11/FaceVisa.

## Demo video

TODO (Rohit): the link, and the times of each moment:

| Moment | For | Time |
|---|---|---|
| A brand without a World ID check is refused (`presence_required`), then a check is cancelled: "Nothing changed" | World | `[mm:ss]` |
| A creator completes the World ID check (Proof of Human, World ID sandbox) and lists | World | `[mm:ss]` |
| The brand's agent shortlists creators, read from Arkiv, with their stats | Arkiv | `[mm:ss]` |
| The creator approves the exact ad in FaceVisa | all | `[mm:ss]` |
| Paid: USDT on Whitechain, no wallet or gas for the brand; the creator sees "Paid" and the explorer link | Whitechain | `[mm:ss]` |
| Verify: Licensed, the payment confirmed, "On Swarm ↗" opens the same file | Arkiv, Swarm, Whitechain | `[mm:ss]` |
| The direct verifier and the receipt in Arkiv's explorer (`swarm_ref`) | Arkiv, Swarm | `[mm:ss]` |

## How it works

1. **Sign in.** One account has both a creator profile and a brand workspace; the top bar switches between them.
   Our backend is the OpenID Connect client (authorization code with PKCE S256, the ID token validated against the
   issuer's JWKS), and the browser only carries our HttpOnly session cookie. The providers:
   - **Sign in with Google** (`GOOGLE_SIGNIN=1`, scopes `openid profile`: the Google name becomes the display name;
     no email). On the public demo it
     replaces the demo identities, and Google accounts keep the demo's protections: per-network limits on new
     accounts, images and videos; testnet USDT top-ups; captures and ads deleted after 48 hours.
   - the **dev sign-in** locally (next to Google);
   - World ID sign-in only with `WORLDID_SIGNIN=1` (off).
2. **Creators make a live capture, prove presence with World ID, and set rules.**
   - **Capture:** a camera-only capture with a liveness check: blink, then turn slightly each way. Three frames, no
     uploads, stored only with consent.
   - **Rules:** a price per ad (video is 3×), the longest licence they allow, and the categories they refuse.
     Political, adult, minors, impersonation and deception are refused for everyone.
   - **Proof of Presence** (World ID Selfie Check through IDKit) before listing: one World ID, one listed face
     (below).
   - There is no creator agent.
3. **The brand's agent shortlists and asks.** The brand gives a brief, usage (category), duration, a maximum price and
   a budget. The agent shortlists every listed creator, with their face and one line of why for each pick and skip.
   The Creators page lists everyone listed, with prices and refused categories. Faces (the first frame of the live
   capture) are shown only to signed-in accounts, and never go to Arkiv. Among picks, a
   creator's linked YouTube channel counts: a topic that fits the usage, the face match, then subscribers. Linking a
   channel is optional and never required to list.
4. **The agent makes the ad, unreleased.** A request that fits the creator's rules is generated straight away and
   stays private. The face gate compares the ad (a video's opening still) with the creator's capture frames and
   regenerates once on a mismatch.
5. **The creator approves the finished ad, in FaceVisa** (below). Signed in, only they see the actual ad and its
   terms, then approve, reject (the agent makes one new version), or deny. The approval names the file the page
   showed, and is bound to its sha256, the brand, usage, duration and price, once.
6. **Big spends need the brand's approval.** Above `BRAND_STEPUP_USDC` per request, the agent pauses until the brand
   approves that exact amount in FaceVisa. Below it, the agent pays on its own within the brand's daily budget.
7. **Paid, then released, once.** After the creator's approval, the release step pays the creator in USDT on
   Whitechain testnet: the brand's key signs one authorization, FaceVisa's relayer pays the gas, and the settlement
   contract moves the USDT and emits `LicensePaid` ([below](#whitechain-usdt-payments-nobody-notices)). The release
   re-checks the approval binding and creates one licence and one receipt in one transaction. Deny, cancel or let it
   expire, and nothing is released or charged. Fees aren't refunded after release; revoking stops future use.
8. **Verify.** Anyone can drop a file (hashed in the browser) or paste a sha256. The answer is Licensed, Revoked,
   Expired or Unknown, with "Approved by the creator in FaceVisa, \<time\>" for that exact file, what
   made it (provider, model, request id), the face check and the payment. The creator can revoke any time.

## World ID IDKit: Proof of Presence before a face is listed

### The trust moment

**Listing a face for paid licensing.** Once a creator is listed, brands' agents find them, make ads of that face and
pay for them. Two things must not happen at that moment:

- **a script lists faces**, scraped or synthetic, to collect licence fees;
- **one person lists many profiles**, to multiply income or to come back after a revocation or a ban.

So listing needs exactly two facts: **a real person is present now**, and **this person hasn't listed before**.
Nothing else about them.

### Why Proof of Presence is the minimum sufficient credential

| Credential | What it would give us | For this moment |
|---|---|---|
| Proof of Human (Orb) | the strongest uniqueness | **too high a bar:** most creators have never been near an Orb, and listing a face is a side gig, not a reason to travel to one |
| Passport / NFC | name, nationality, date of birth from a document | **far more than needed:** we'd hold personal data we never use, and a creator would have to own a chip passport |
| **Proof of Presence (Selfie Check)** | liveness in the World ID app, once per person per action (the nullifier), and a sybil risk signal | **exactly the two facts:** a present human, and one listing per World ID. The selfie stays in the World ID app; we receive a proof, a nullifier and a score |

**We ask for Selfie Check, and accept Proof of Human too** (IDKit's `any()` of the two).
- **Why both:** a creator who already holds Proof of Human (the Orb) shouldn't need a second check. It proves one
  unique human for the action as well, and sends us no more data than a Selfie Check: a proof and a nullifier.
- **What we don't ask for:** we never require the Orb, and never a document.
- **The difference:** Proof of Human has no `sybil_score`, so it's never held for review.
- **The trigger** (5 Nov): World's sandbox lists Selfie Check as "Coming soon", and the production World App offered
  only the Orb.
- **In World's sandbox we ask for Proof of Human alone.** Its app stalls silently on any request that includes
  Selfie Check, even inside `any()`, while a Proof of Human request completes. Production keeps `any(selfie,
  proof_of_human)`. The server tells the page which credentials each request asks for.

### What it does NOT prove

- **Whose face is listed.** Selfie Check shows a real person was present in the World ID app. It doesn't tell us
  that the face in our capture is theirs: we never see their selfie. Our own layers cover that:
  - the **live capture** with liveness (blink and turn) in our app, one person across three frames;
  - the **face gate** on every generated ad (it must match the capture);
  - the **creator's own approval** of each finished ad.
- **Identity, age or nationality.** Not asked, not stored.
- **Uniqueness at Orb strength.** The `sybil_score` is "a risk signal, not a uniqueness verdict" (World). Above our
  limit (`PRESENCE_MAX_SYBIL_SCORE`, default 3 of 10), the proof is **held for review**, not refused.

### How the check runs

1. **Signed request.** The creator's backend signs the request with the RP key (`signRequest`, IDKit server 1.2.0). The
   key is read from a `chmod 600` file and never reaches the browser. The signal is bound to the account
   (`facevisa:<uid>`), and the nonce is single use, valid 5 minutes.
2. **The World ID app.** IDKit 4.6 shows a QR code for `any(selfie, proof_of_human)` (in the sandbox,
   `proof_of_human` alone). The creator scans it and completes the Selfie Check, or shares the Proof of Human they
   already hold.
3. **Our backend checks the result.** In order:
   - the nonce is ours, open and unexpired, and it's claimed at once;
   - World ID 4.0, our action, and the environment pinned to the server's;
   - a Selfie Check (issuer schema 11) or Proof of Human (issuer schema 1) response, whose signal hash is this
     account's;
   - for a Selfie Check, the integrity bundle.
4. **World verifies it** (`POST developer.world.org/api/v4/verify/{rp_id}`): the proof, the integrity bundle (which
   covers the score), our signature and the nonce.
5. **Our rules.**
   - The nullifier must be unique for the action: one World ID, one listed profile.
   - Then, for a Selfie Check, the `sybil_score`: within the limit, the creator may list; above it, the proof is held
     for review. A Proof of Human lists straight away.

Code: [presence.ts](agents/src/app/presence.ts) (server), [PresenceCard.tsx](web/components/facevisa/PresenceCard.tsx)
and [PresenceWidget.tsx](web/components/facevisa/PresenceWidget.tsx) (web). Every step is logged as `[presence]` (times, World's answer in full, the score
and environment; nullifiers redacted).

### The success path and the alternative paths

| Path | What happens | What the creator sees |
|---|---|---|
| **Success** | proof verified, nullifier stored (its value never logged) | "Proof of Presence done"; the profile can be listed, with the Proof of Presence badge |
| **Cancel** in the World ID app, or the widget closed (**tested**) | IDKit's end code logged; nothing else changes | "You cancelled in the World ID app. Nothing changed."; the profile stays **Draft** |
| **Once only:** the same World ID on a second account | our nullifier rule, or World's own refusal (`nullifier_replayed`, `max_verifications_reached`); **done live: 5 Nov 19:00 UTC and 6 Nov 07:04 UTC** | "This World ID has already completed Proof of Presence for FaceVisa: it's already listed under another account." |
| **Held for review:** a Selfie Check's `sybil_score` above the limit | stored as held; not listed; `pnpm presence:review` clears or rejects it | "Under review… a person at FaceVisa reviews it" |
| Wrong environment, expired, another account's proof, World refuses | refused with the reason; nothing stored | the reason, in words; try again |
| Credential unavailable in the app | IDKit's code logged | "Your World ID app doesn't have Proof of Presence yet…" |

### Environments: sandbox is always labelled

- **A proof counts only in its own environment.** One account never mixes environments or actions: a second
  attempt from another environment is refused.
- **Production** is for the real site (`facevisa-v1`, the once-only action `list-likeness`).
- **Sandbox** runs only on the dev database or the public demo; the server refuses to start otherwise.
- **Sandbox proofs are labelled "World ID sandbox"**, and every badge names the credential: "Proof of Presence (World
  ID sandbox)" or "Proof of Human (World ID sandbox)". The labels appear on the creator's profile, the brand's
  shortlist, the creator's Arkiv listing (`presence = sandbox`, `credential = selfie | proof_of_human`) and their
  public creator page. They are never called production verification.

### On the public demo (https://facevisa.site)

**Creators and brands are both verified with World ID** (Rohit, 6 Nov). It's one check per account, covering both
workspaces: Proof of Human from the sandbox World ID app, since the sandbox can't do the Selfie Check yet. Once per
person.
- **A creator** lists only after the check.
- **A brand** shortlists and requests ads only after the check. Before it, the server answers `presence_required`.
- **The brand agent** picks only creators with a check. Listings from before the rule (the seeded ones) are skipped
  with "skip: no World ID check".

## Approvals in FaceVisa

Two approvals, the same rules ([`approval.ts`](agents/src/app/approval.ts)). Every check runs in our backend.

| | Creator: the finished ad | Brand: a spend over the limit |
|---|---|---|
| Who | the signed-in creator the ad is of (no one else can open or decide it) | the signed-in brand workspace that asked |
| Bound to | the file the page showed (its sha256; refused if the ad changed); the approval to hash + brand + usage + duration + price | the amount the page showed (refused if the price changed) |
| Request | a POST with the session's CSRF token | same |
| Decision | approve / reject (one regeneration) / deny, once | approve / deny, once |
| Unsuccessful | another person gets 404; no CSRF token, 403; a changed ad, 409; deny or expiry (`AGENT_PASS_REQUEST_TTL_MIN`) releases nothing and charges nothing; release without the approval is 403 | same; deny or expiry spend nothing |
| Labelled | "approved by the creator in FaceVisa" (Verify, the brand's log, Arkiv's `identity`: `dev` or `demo`) | "spend approved by the brand" |

A request to your own creator profile from your own brand workspace still waits for your approval as the creator.
The brand's **Agent activity log** shows every step: requested → generated → waiting → approved → (spend check →
spend approved) → paid → released, or blocked with the reason.

## Identity layers

| Layer | What it shows | What it doesn't |
|---|---|---|
| Sign-in (Google on the public demo; a dev sign-in locally) | who you are here: one account per identity | not a real-world identity: Google proves a Google account (labelled `google`), and the dev sign-in is a test identity (labelled `dev`) |
| Proof of Presence (IDKit Selfie Check), or Proof of Human | a real person (present now, for a Selfie Check), listing once per World ID; a sybil risk signal for a Selfie Check | not whose face is in our capture (the next two rows cover that) |
| Live capture with liveness | a live, moving face in front of the camera at capture time (blink and turn, MediaPipe in the browser); the server checks the three frames show one person | not a certified presentation-attack test; the liveness flags come from the browser |
| Face gate on every output | the generated ad shows the person in the capture (YuNet + AuraFace, cosine ≥ `CONSENT_FACE_MATCH_THRESHOLD`) | the threshold is calibrated on a small sample (one real person, two synthetic faces; below): re-check it with more creators |
| YouTube channel + face match (optional) | which public creator this is: "Verified YouTube channel" = the channel belongs to the Google account that granted read-only access; "Face matches channel" = 2+ of its picture and 5 most recent thumbnails match the live capture | faceless channels get no face badge (never blocked); thumbnails are noisy (other people, graphics, heavy edits); while the Google consent screen is in testing mode, only its test users can link, and Google shows its "unverified app" warning |
| The creator's approval in FaceVisa | the signed-in creator approved this exact file and terms, once | not a fresh re-authentication at the moment of approval (we may add IDKit session proofs later) |
| The brand's spend approval in FaceVisa | the signed-in brand approved this exact amount | same |

World ID sandbox proofs and the dev sign-in are test identities, not real verification.

### Face gate calibration (5 Nov 2026)

`CONSENT_FACE_MATCH_THRESHOLD` is **0.35**: an ad is released for review only if its face scores at least that
against the creator's capture (cosine similarity of AuraFace embeddings, YuNet detection). On the data we have, 0.35
separates the right person from other people, but **the sample is small and should not be read as a measured error
rate.**

**Faces:**
- **One real person:** Rohit, with his own capture and consent.
- **Two synthetic faces:** AI-generated portraits of people who don't exist (`agents/assets/`). Several test creators
  share each one, so they are grouped by face and each face counts once.
- No other real person's face has been used.

**Samples:** each model-made image is scored against its own creator's capture (genuine) and against each other face
(impostor).

| | Samples | Range | Median |
|---|---|---|---|
| **Genuine:** the ad's own creator | 10 | 0.515 to 0.888 | 0.608 |
| **Impostor:** another face | 20 | −0.014 to 0.287 | 0.116 |

- **Genuine samples (10):**
  - 6 of Rohit: 3 Gemini images and a Gemini video still on Vertex, plus a Seedream image and a Seedream video still
    on 0G;
  - 4 of the synthetic faces: 2 Seedream images each, made with the app's prompt for this calibration.
- **By model:** Gemini 0.515 to 0.554; Seedream 0.608 to 0.888. Gemini changes the face more.
- **Separation:** every genuine score is at least 0.515, and every impostor score at most 0.287. So 0.35 sits 0.165
  below the lowest genuine score and 0.063 above the highest impostor (one synthetic face's ad scored against the
  other synthetic face).
- **Test renders are left out:** they paste the capture itself, so they would inflate the genuine scores.

**What this doesn't show:**
- how the threshold behaves across many real people, ages, skin tones, lighting or look-alikes;
- false-accept or false-reject rates.

Re-check it with more creators (and other photos of each) before relying on it. `--photos` and `--generated` each
take a folder with one subfolder per creator, named by display name:

```sh
cd agents && pnpm face:calibrate --db=local,<backups…> --photos <dir> --generated <dir>
```

## Not yet

- **Payments are on Whitechain testnet only** (USDT with no value). Without `WHITECHAIN_SETTLEMENT`, DevPayment records
  payments and moves no money.
- **AI generation:** per media type, with `FACEVISA_AI_IMAGE` and `FACEVISA_AI_VIDEO` (`0g` or `vertex`; empty means
  TEST RENDERs, made from the capture without any model call). Images run on 0G; video stays on Vertex, because 0G's
  video model refuses real people's faces. Another submission's GCP project is refused at startup.
- **World ID checks run in World ID's sandbox, not production.**
  - The first real one: Proof of Human, 5 Nov 17:34 UTC.
  - A real Selfie Check (Proof of Presence) hasn't completed anywhere yet:
    - the sandbox lists it as "Coming soon";
    - production World App offered only the Orb.
  - The real site's production action stays unused
    ([INTEGRATION_DEBRIEF.md](INTEGRATION_DEBRIEF.md#idkit)).
- **Agent Pass is dropped** (archived in `agents/archive/`). **World ID sign-in** stays behind `WORLDID_SIGNIN=1`
  (off): it never completed a real run.
- **Face gate:** runs only when its models are present (`pnpm face:models`). Without them, receipts say "face check:
  not run".
- **The face threshold is calibrated on one real person and two synthetic faces** (above). It needs re-checking with
  more creators.

## Arkiv: the public record of every deal

FaceVisa keeps its own database (SQLite) as the authority, and mirrors the public side of each deal to
[Arkiv](https://arkiv.network) on the Rabdi testnet (chain 7794095) after every commit:
- **Listings:** the creator's offer, owned by the creator's key, renewed while they stay listed.
- **Requests:** the brand agent's ask, owned by the brand's key. It lives only for the review window: **10 minutes**
  by default.
- **Licences:** owned by the creator's key, who alone can revoke; they expire when the licence ends.
- **Receipts:** read-only, owned by FaceVisa's receipt key. They name the licence's creator and end, so they still
  answer after the licence entity has expired.
- **Revocations:** when a creator revokes, their key also writes a read-only revocation record with the longest
  lifetime, so "Revoked on <date>" outlives the licence entity.

Where users see it:
- **Read from Arkiv, and labelled so:**
  - **The brand agent's shortlist:** picks and skips come from Arkiv's query of listings that fit the brief.
  - **The creator's inbox:** pending requests for their address, with Arkiv's review deadline.
  - **Verify:** a file's receipt, then its licence, each checked for the right owner. It says Licensed, Revoked, or
    "Licence expired on <date>" (the revocation record is checked first).
- **[The direct verifier](#check-a-licence-yourself-the-direct-verifier):** the same check, from Arkiv alone, in
  anyone's browser.

Details:
- [arkiv/schema.md](arkiv/schema.md): the entities, queried fields, owners and expiry, and the demo's entities with
  explorer links;
- [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md): each feature and what it changes for users, the live
  runs, the numbers;
- [arkiv/why-arkiv.md](arkiv/why-arkiv.md): what users would lose, and what we keep off Arkiv;
- [arkiv/reach.md](arkiv/reach.md);
- [arkiv/friction.md](arkiv/friction.md).

**Namespaces** (the `app` attribute):

| Namespace | What's in it |
|---|---|
| `facevisa-public` | **The judge-facing namespace:** the public demo at facevisa.site (Google sign-in, labelled). Its showcase ads are seeded after the first live Whitechain payment, so they're paid in USDT on Whitechain. **Faces, consent first:** Rohit's own capture (his consent), and "Asha (synthetic demo creator)", an AI-generated face of a person who doesn't exist. No stranger's face is used (the landing page's example portraits are stock illustrations, not creators). |
| `facevisa-dev` | Development. |
| `facevisa-v1` | Reserved for real data (a production World ID check before listing). The backend refuses dev sign-in or DevConsent data there. Empty. |

Entities from earlier test runs ([arkiv/](arkiv/)) are in earlier namespaces, no longer used, until they expire.

The demo video's Arkiv moments: [Demo video](#demo-video).

### Writer addresses (Rabdi)

| Key | Address | Writes |
|---|---|---|
| Receipt key (FaceVisa) | [`0x9625c5E37D8826cD9459DAffb7Bb78999CBf00cA`](https://rabdi.explorer.arkiv.network/address/0x9625c5E37D8826cD9459DAffb7Bb78999CBf00cA) | every receipt, read-only. This is the address verifiers trust. |
| Funder (FaceVisa) | [`0x6a3b3c329F854F63637Ea021880e580B4B00A76f`](https://rabdi.explorer.arkiv.network/address/0x6a3b3c329F854F63637Ea021880e580B4B00A76f) | no app entities: it tops up account keys with tGLM (and signed our smoke and live tests, in their own namespaces) |
| Rohit's account (creator and brand) | [`0xe668c0adec9ee9e104256e35d20ef586c1e136d9`](https://rabdi.explorer.arkiv.network/address/0xe668c0adec9ee9e104256e35d20ef586c1e136d9) | his listing, the licences of his ads, his requests as a brand, his `creator_stats` and `brand_stats` |
| Asha (synthetic demo creator) | [`0xd0376d5217921777b2c378d6d7f886073aa17a3a`](https://rabdi.explorer.arkiv.network/address/0xd0376d5217921777b2c378d6d7f886073aa17a3a) | her listing and `creator_stats` |
| Daniel (synthetic demo creator) | [`0x201ba36f8d44e2f04e4293af05789947d9a4b6bb`](https://rabdi.explorer.arkiv.network/address/0x201ba36f8d44e2f04e4293af05789947d9a4b6bb) | his listing and `creator_stats` |

Every account gets its own key, generated on first need. **Ownership is custodial:** FaceVisa holds these keys in an
encrypted keystore. The path to self-custody is Arkiv's `changeOwnership`: a creator's key hands their listing and
licences to a wallet they hold. The protocol allows it; the app doesn't offer it yet
([how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md#who-can-edit-each-entity)).

### One query to run

Every ad released on the public demo, from Arkiv's public endpoint (no access key needed): its receipt, the payment
on Whitechain, and the file on Swarm.

```sh
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d @- <<'EOF' \
  | jq -c '.result.data[] | {key, owner, receipt: (.attributes | map({(.name): .value}) | add)}'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = str('facevisa-public') AND type = str('receipt')",
 {"select":{"key":true,"owner":true,"attributes":{"file_hash":true,"creator":true,"payment_rail":true,"payment_ref":true,"payer":true,"swarm_ref":true,"swarm_encrypted":true}},"limit":"0xa"}]}
EOF
```

What it returns (6 Nov 2026: three receipts):
- **`owner` is `0x9625…00ca` on every one:** FaceVisa's receipt key, the address verifiers trust. A receipt from any
  other owner is ignored.
- **`creator`** is the creator's own key (`0xe668…36d9`); their licence entity, owned by that key, says active or
  revoked.
- **`payment_ref`** is the USDT settlement on Whitechain (`payment_rail: whitechain`), and **`payer`** the brand
  workspace's wallet that paid. The receipt released before `payer` was added doesn't carry it.
- **`swarm_ref`** (the showcase ad, `swarm_encrypted: false`): the same file on Swarm, at
  `https://api.gateway.ethswarm.org/bzz/<swarm_ref>/`. Its sha256 is the receipt's `file_hash`.
- Add `AND file_hash = str('0x…')` to ask about one file; `type = str('creator_stats')` for each creator's numbers.

### Check a licence yourself: the direct verifier

[`web/public/verifier/index.html`](web/public/verifier/index.html) is a static page. It never calls a FaceVisa server
and uses no access key.
- **To open it:**
  - from disk: open the file in a browser;
  - when the web app runs: at `/verifier/index.html`;
  - or put the folder on any static host.
- **To use it:** drop the ad file (or paste its sha256).
- **What it does:**
  1. Hashes the file in the browser; only the hash is sent.
  2. Asks Arkiv's public JSON-RPC endpoint for the receipt for that hash, owned by the published receipt address
     `0x9625…00cA`.
  3. Asks for its licence, which must be owned by the creator address the receipt names.
- **What it shows:**
  - status: Licensed, "Revoked on <date>", or "Licence expired on <date>";
  - the licence's expiry;
  - the creator's display name next to their address, read from their own listing on Arkiv;
  - how the file was made (model, face check and score);
  - the payment: USDT on Whitechain, with `LicensePaid` checked on Whitechain's RPC from the browser;
  - how the creator approved (in FaceVisa, signed in with Google on the public demo);
  - explorer links. Anything that fails the
  ownership checks is "not trusted".
- **Settings:** the namespace defaults to `facevisa-public`. Override with `?ns=`; `?hash=` checks a hash straight
  away.
  - A link can also set `?receipt=` and `?rpc=`. With anything but the published ones, the page never shows FaceVisa's
    verdict: it says "Not verified by FaceVisa (custom settings)", gives the answer under those settings as a detail,
    and offers a button back to the published settings.
- **Rate limit:** Arkiv's public endpoint is rate-limited per IP address. When we measured, it answered
  `RateLimit: limit=2000, reset=10` (units per 10 s), with `Arkiv-Cost: 10` per query. One check makes 5
  requests (about 1.5–2 s), so a person checking files by hand won't hit it, but a script hammering it will.

### Where is my face used: every licence of one creator

[`web/public/verifier/creator.html`](web/public/verifier/creator.html) sits next to the direct verifier: the same static
page, the same `verify.js`, no FaceVisa server and no access key. Give it a creator's address (the key that owns
their listing and licences); each creator's dashboard links to their own page.

- **It reads:**
  - every receipt naming that creator, from the published receipt address only;
  - the licence and revocation entities the creator's own key owns;
  - the creator's listing, for their name.

  That's 6 requests in all. A flood of fake receipts can't hide the real ones: those are queried by owner.
- **It shows,** for each file:
  - Licensed (until …), "Revoked on …", Expired, or Not trusted, with the same rules as the per-file check (a test
    holds the two to the same verdicts);
  - the brand's address, the usage and duration, and how the creator approved;
  - the model and face score;
  - the payment, checked on Whitechain's RPC (`LicensePaid`);
  - links to the entities and to the file's own check.

  Receipts naming the creator from other addresses, and licences with no receipt, are ignored and counted.
- **It can't show** copies made outside FaceVisa: only released ads have receipts.

Try it on the demo:
- [where Rohit's face is used](https://facevisa.site/verifier/creator.html?creator=0xe668c0adec9ee9e104256e35d20ef586c1e136d9&ns=facevisa-public):
  his stats entity, and each licensed ad with its receipt, licence, payment and Swarm link;
- [one showcase ad, checked](https://facevisa.site/verifier/index.html?ns=facevisa-public&hash=0x45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220):
  Licensed, the USDT payment confirmed on Whitechain, and the same bytes on Swarm.

### Numbers (Rabdi)

- **Gas used per write** (at 1 gwei, 100,000 gas = 0.0001 tGLM):

  | Write | Gas used (median) |
  |---|---|
  | listing create | ~377,000–405,000 |
  | request create | ~190,000 |
  | licence create | ~223,000 |
  | receipt create | ~553,000 |
  | patch | 43,000–55,000 |
  | account-key top-up | 21,000 |

- **Entities (earlier namespaces):** 10 in the demo namespace, 25+ in the dev one.
- **Query latency:** about 310 ms median per query from our machine (p90 under 530 ms), with or without an access key.
- **Write latency:** a write is confirmed 4.3–5.7 s after signing.
- Source and method: [how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md#numbers), `pnpm arkiv:metrics`.

### What stays off Arkiv

Everything personal or private stays in FaceVisa's database:
- live captures and photos (biometric);
- the ad files (Arkiv has their sha256);
- brief text and prompts (Arkiv has a `brief_hash`);
- World ID subjects and checkpoint evidence (Arkiv has only the label `world-id`, `standin` or `dev`);
- emails, brand names, YouTube data, private keys.

Arkiv gets what an outsider needs to check a deal, as hashes and addresses ([why-arkiv.md](arkiv/why-arkiv.md)).

### How AI was used

- **[Claude Code](https://claude.com/claude-code)** (Anthropic) wrote most of FaceVisa's code, tests, scripts and
  docs (the Arkiv, Swarm, Whitechain and World ID integrations, the web app and the deploy), working from Rohit's
  tasks and decisions, with Rohit approving each step. Rohit ran
  the live tests: the World ID checks on his phone, the sign-ins and the approvals.
- **The ads themselves are AI-generated** (images on 0G Compute, videos on Vertex AI), labelled "AI-generated" on
  the file and in every receipt.
- **Arkiv's own Claude Code plugin** (`Arkiv-Network/ai-plugin`, its skills and the Mumbai MCP profile) supplied the
  SDK 1.0.x guidance: the write-safety rules our outbox follows, the query and expiration recipes, and the network
  details.
- Everything was run and checked against Rabdi: the live runs, the entity links and the numbers above.

## Whitechain: USDT payments nobody notices

**Testnet only** (Whitechain Sepolia, chain 1874). The USDT is Whitechain's testnet Tether, with no value.

The brand approves a budget once. The creator approves the exact ad. After that, payment just happens:
- the brand never holds gas, signs a transaction, or sees a wallet;
- the creator sees "Paid" with a link to the explorer.

### Why on-chain stablecoin settlement

- **Proof anyone can check.** A licence is only worth something if the creator was really paid. `LicensePaid` names
  the file's sha256, the licence, the creator and the amount. The public verifier reads it from Whitechain's RPC in
  the browser: no FaceVisa server, no trust in our database.
- **Dollars, not a volatile token.** Creators price an ad in dollars, so they're paid in USDT.
- **Small amounts work.** An ad licence costs cents to a dollar. A card payment or a bank transfer per ad would cost
  more than the ad. A Whitechain transaction costs a fraction of a cent in gas, and FaceVisa pays it.
- **Direct to the creator.** The contract forwards the USDT to the creator's own address in the same transaction.
  FaceVisa never holds it.

### The contract: FaceVisaSettlement

- **Address:** [`0x8fbbca9e637c6261386e38dfef016a7dd90fc65b`](https://explorer.testnet.whitechain.io/address/0x8fbbca9e637c6261386e38dfef016a7dd90fc65b).
  - Source verified on Blockscout (solc 0.8.24, optimizer 200).
  - Deployed 6 Nov 2026, 08:40 UTC in [`0xb7dfb5d2…2ea8`](https://explorer.testnet.whitechain.io/tx/0xb7dfb5d2d4f3b8810e37c8901a05a4dd0a19d654e39f362123da5ec1751d2ea8).
- **Source:** [`contracts/src/FaceVisaSettlement.sol`](contracts/src/FaceVisaSettlement.sol).
- **USDT:** [`0xcedfB561…f55a7`](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7)
  (TetherTokenV2: EIP-3009 `receiveWithAuthorization`, 6 decimals).

`settle(payment, signature)`, relayer only:
1. checks the parties, the caps and that this licence isn't paid yet;
2. pulls the price from the brand with the brand's signed `ReceiveWithAuthorization`;
3. forwards it to the creator;
4. emits `LicensePaid(fileHash, licenceId, creator, brand, amount)`.

**The signature is bound to one licence.** Its EIP-3009 nonce is
`keccak256(keccak256(licenceId), fileHash, creator, amount)`, recomputed by the contract. So a signature can't pay
another licence, another file, another creator or another amount. Tether makes each nonce single-use, and the
contract pays each licence once.

**What stops draining:**
- only the relayer can call `settle`;
- the relayer holds WBT for gas, never USDT. It's funded with WBT from Whitechain's faucet (2 WBT a day). 0.5 WBT
  covers about 700 settlements at ~138,600 gas and ~5 gwei (0.4955 WBT left on 6 Nov); `/api/health` warns under 0.05 WBT, and a payment is refused
  before anything is signed if the relayer can't pay its gas;
- caps per payment (1.00 USDT) and per UTC day (20.00 USDT), in the contract and again in the backend;
- a gas-price ceiling (50 gwei) in the backend;
- the owner can pause the contract.

**Refunds:** none. Fees aren't refunded after release; revoking a licence stops future use.

### The payment flow

```
creator approves the exact ad in FaceVisa (bound to its sha256, brand, usage, duration, price)
  │
release step (agents/src/facevisa/pipeline.ts → WhitechainRail)
  ├─ authorize: caps · brand's USDT balance (public demo: top-up from the operator) · relayer's gas
  │    brand's custodial key signs ReceiveWithAuthorization(brand → settlement, price, 1 h, nonce bound to the licence)
  │    dry run (eth_estimateGas)
  ├─ settle: relayer signs settle(); its tx hash is saved BEFORE broadcast (a restart finds it, never pays twice)
  │    FaceVisaSettlement: receiveWithAuthorization → transfer to creator → LicensePaid
  ├─ receipt: success + LicensePaid checked → payment settled
  └─ licence + receipt created; Arkiv receipt: payment_rail "whitechain", payment_ref = tx hash
```

- **Slow chain:** if no receipt comes within 90 s, the request stays "paying" and the backend keeps checking the
  chain every 15 s (and again after a restart). A success finishes the release. A revert, or no transaction an hour after the authorization ran out, returns the
  request to approved with nothing charged.
- **Inside the release step.** Payment happens after the creator's approval, with no extra step for the brand. The
  brand's agent is optional.

### Architecture

| Part | Where | What it uses |
| --- | --- | --- |
| The contract | [`contracts/src/FaceVisaSettlement.sol`](contracts/src/FaceVisaSettlement.sol) | Tether's EIP-3009 |
| The payment rail: sign, relay, reconcile, top-ups, status | [`agents/src/whitechain/whitechain.ts`](agents/src/whitechain/whitechain.ts) | viem; legacy transactions signed locally and sent raw |
| Choosing the rail (`PAYMENTS`) | [`agents/src/app/runtime.ts`](agents/src/app/runtime.ts) | `whitechain` (default) · `dev` (test payments, no money moved) |
| Health: relayer gas, paused, operator USDT | [`agents/src/app/health.ts`](agents/src/app/health.ts) | warns under 0.05 WBT |
| Verify's payment check | [`facevisaRoutes.ts`](agents/src/app/facevisaRoutes.ts) | `eth_getTransactionReceipt`, `LicensePaid` + the USDT `Transfer` |
| The direct verifier's payment check, in the browser | [`web/public/verifier/verify.js`](web/public/verifier/verify.js) | Whitechain's public RPC (CORS `*`) |

**Keys** (all files `chmod 600`, git-ignored, never logged):
- **The creator is paid into their account's custodial key** from the encrypted keystore: the same key that owns
  their Arkiv entities.
- **The brand pays from its workspace's own wallet** (`wallet:brand-<uid>`, also in the keystore). One account holds
  both workspaces, so a brand can license its own creator profile and USDT still moves between two addresses (the
  contract refuses a payment to oneself). The receipt on Arkiv names that wallet (`payer`), and the verifier checks
  `LicensePaid`'s brand against it.
- **The relayer:** `.secrets/whitechain-relayer-key`,
  [`0x7470…d6ca`](https://explorer.testnet.whitechain.io/address/0x74709c3dF42A03BA745D4Ab39d687ab8CE7Fd6ca). It holds
  WBT only.
- **The operator:** `.secrets/whitechain-operator-key`,
  [`0xe691…1265`](https://explorer.testnet.whitechain.io/address/0xe6918b88b43d432E003Ef529CEB8d13e51331265). It owns
  the contract and holds the demo's USDT reserve.

### Setup

1. **Gas.** Fund the relayer and the operator with testnet WBT from
   [faucet.testnet.whitechain.io](https://faucet.testnet.whitechain.io): 2 WBT a day, with a GitHub account older
   than 30 days.
2. **USDT.** The operator needs testnet USDT for the demo's top-ups: swap WBT for USDT on
   [testnet.yetitrade.fi](https://testnet.yetitrade.fi/). Use USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`
   (6 decimals), the only USDT that counts for Whitechain's prizes.
3. **Contract** (only to redeploy):
   ```sh
   cd contracts && forge test
   forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.whitechain.io --broadcast
   ```
   Then verify the source on Blockscout.
4. **Env.** `PAYMENTS=whitechain` (the default) and `WHITECHAIN_SETTLEMENT=0x8fbbca9e637c6261386e38dfef016a7dd90fc65b`. Caps and the other
   settings are in [`.env.example`](.env.example).
5. **Check.** `pnpm app` prints `[whitechain] payments on …`. The preflight and `/api/health` show the relayer's gas
   and the operator's USDT.

### Settled on Whitechain testnet

| Payment | USDT | Transaction |
| --- | --- | --- |
| **The main flow, on the public demo:** an image of Rohit, licence `lic_fde8f086a3de765e` | 0.05 | [`0x632ec6d3…2d9e`](https://explorer.testnet.whitechain.io/tx/0x632ec6d388829fb964e23035e083538834e29c41c537cc3d7ce3960592c92d9e) |
| **The main flow:** a video of Rohit, licence `lic_da1c80ad71a22bd1` | 0.15 | [`0xceff7eb5…7ae3`](https://explorer.testnet.whitechain.io/tx/0xceff7eb54e2f5a341f5f2448fbfe8366b852825eb8ae87a484999c22c0367ae3) |
| **The main flow:** the showcase image (also on Swarm), licence `lic_8100bb9357f91ed6` | 0.05 | [`0x1508d442…8432`](https://explorer.testnet.whitechain.io/tx/0x1508d44255adce49f1e7b108f141f9bbfbbc5f1d4e5d27f1175238af37dc8432) |
| The first live payment (`pnpm e2e:live`, development): Acme Running Co → a synthetic creator, licence `lic_c342bea68c5245c7`, 6 Nov 09:21 UTC | 0.05 | [`0x55fa60a9…5aaa`](https://explorer.testnet.whitechain.io/tx/0x55fa60a9e79d5f9ebbf5fcb60e96a640708dd20457b85505c87adc09419e5aaa) |

- **The main-flow payments** went from the brand workspace's wallet
  ([`0xe626…28ab`](https://explorer.testnet.whitechain.io/address/0xe626178d3902679f8be6f3846c5d28ec133228ab)) to the
  creator ([`0xe668…36d9`](https://explorer.testnet.whitechain.io/address/0xe668c0adec9ee9e104256e35d20ef586c1e136d9)),
  about 138,600 gas each, paid by the relayer. Each one's Arkiv receipt carries its `payment_ref`.
- **The first release, approval to paid file, took 4.1 s**; Verify confirmed `LicensePaid` from the RPC.
- **Gas:** 172,866 (0.00086 WBT), paid by the relayer
  ([`0x7470…d6ca`](https://explorer.testnet.whitechain.io/address/0x74709c3dF42A03BA745D4Ab39d687ab8CE7Fd6ca)). The brand
  held only USDT.
- **The public verifier checked it from Arkiv and Whitechain's RPC alone:** the transaction succeeded, `LicensePaid`
  came from the settlement contract, for this file, licence, creator, brand and price (0.05 USDT).

### Limitations

- **Testnet only**, and custodial: FaceVisa holds each account's key in its encrypted keystore and signs the
  brand's authorization for them. The approvals gate it: the creator's approval of the exact ad, and the brand's for
  spends over its limit.
- **No refunds** after release (above).
- **One relayer, one transaction at a time.** Payments are queued, which is fine at demo volume.
- **Caps are small on purpose** (1 per payment, 20 a day). Raising them needs the owner's `setCaps`.

Friction and feedback for the Whitechain team: [WHITECHAIN_FEEDBACK.md](WHITECHAIN_FEEDBACK.md).

## 0G: the ad images are made on 0G Compute

With `FACEVISA_AI_IMAGE=0g`, every ad image (and a video's opening still) is made on the **0G Compute Router**
(pc.0g.ai), from the creator's own live capture.

### What runs on 0G

| Media | Provider | Model | Why |
|---|---|---|---|
| Images, and a video's opening still | **0G** | `bytedance/seedream-5.0-flash` ($0.027 per image) | It keeps the creator's face from a reference image |
| Video, animated from that still (first frame) | **Vertex** | `veo-3.1-lite` | 0G's video models refuse real people's faces (below) |

- **Set it with** `FACEVISA_AI_IMAGE=0g` and `FACEVISA_AI_VIDEO=vertex`. Empty means TEST RENDERs; unset follows the
  legacy `FACEVISA_AI` ([agents/src/ai/media.ts](agents/src/ai/media.ts)).
- **The key** is read from `.secrets/zerog-api-key` (`chmod 600`), never from env or output.
- **Daily caps** count per media type, whichever provider bills it.
- **A refused 0G video** fails the request with "0G refused this video". It switches to Vertex only if
  `FACEVISA_AI_VIDEO_FALLBACK=vertex` is set; it never switches silently.
- **Every image prompt carries the wardrobe rule** (both providers): clothing from the brief, otherwise plain with no
  logos or text; no accessories from the reference photo; a natural pose for the brief.

### Provenance

- **On each file:** the 0G request ID (`x_0g_trace.request_id`) is stored with the file, and shown in Verify and in
  the direct verifier. The Arkiv receipt carries `provider: 0g`, the model and the request ID (`job_id`).
- **"Verified":** FaceVisa asks for `verify_tee` on every call, but only says "verified" when 0G answers
  `tee_verified: true`. 0G lists no TEE-acknowledged provider for Seedream, and the responses carry no
  `tee_verified`, so Verify says **"0G request record"**: the request is on 0G's record, nothing more is claimed.

### Privacy, exactly

- **The creator's reference image is sent to 0G's Seedream provider** (the response names `provider_identity:
  bytedance`).
- **0G's retention wording** ([docs](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy)):
  - "Prompts and completions are processed in memory only for the lifetime of the request";
  - "Multipart inputs are not stored … never persisted. The Router does not store generated images".
- **The limit:** that covers 0G's Router. On non-private tiers, per 0G, "the upstream provider processes your prompt
  under its own data policy", and 0G doesn't state that policy. No private (TEE-sealed) provider serves Seedream.

### What breaks without 0G

Nothing stops working: with `FACEVISA_AI_IMAGE=vertex` the same flow runs on Gemini. What's lost is facevisa and
price. On the same creator's capture, 0G's Seedream ads matched the face at **0.885–0.910** (4 images), against
**0.513–0.570** for Gemini's, at $0.027 rather than about $0.036 per image.

### On 0G

- **The live run** (development): request `3a0715ea-e42b-4328-a8cf-391ad857f260`, face check passed at 0.888.
  Licensed and paid.
- **The quality test:** 3 more images, at 0.885–0.910.
- **A video:** its opening still made on 0G (request `e9c7e650-77bc-4517-9609-a765ff56064d`, face 0.851), the clip
  animated by Veo on Vertex. Approved by the creator, then over the brand's $0.10 step-up by the brand's human, and
  paid.
- **Video:** two Seedance attempts with a real face, both refused with
  `InputImageSensitiveContentDetected.PrivacyInformation` ("may contain real person"; not charged). See
  our 0G notes.

## Run it

```sh
# once
cd agents && pnpm install && pnpm face:models   # the face matcher's models into .models/ (sha256-pinned, ~250 MB)
cd ../web && pnpm install && pnpm certs          # a localhost certificate (mkcert; run `mkcert -install` once)
cp .env.example .env.local                       # repo root; fill WORLDID_* and SESSION_SECRET (see the comments)

# two terminals
cd agents && pnpm app                            # backend on 127.0.0.1:8788, reads ../.env.local
cd web && pnpm dev:https                         # https://localhost:3000 (WEB_PORT=… for another port)
```

- **Sign-in locally:** `FACEVISA_LOCAL_DEV=1 WORLDID_STANDIN=1 pnpm app` turns on the **dev sign-in**: pick a named
  person, or cancel, or an expired attempt.
  - Local development only, never with `NODE_ENV=production` or on mainnet.
  - Its own issuer; everything it does is labelled `dev`.
- **Sign in with Google:** `GOOGLE_SIGNIN=1` with `GOOGLE_SIGNIN_CLIENT_ID` and `GOOGLE_SIGNIN_CLIENT_SECRET` (a
  Google OAuth web client whose redirect URIs include `<site>/api/auth/callback`). They're kept apart from YouTube
  linking's `GOOGLE_OAUTH_*`, so sign-in doesn't turn YouTube linking on.
- **World ID sign-in (off):** `WORLDID_SIGNIN=1` plus the `WORLDID_*` client settings in
  [`.env.example`](.env.example).
- **The World ID check before listing (IDKit):** `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY_FILE`, and
  `WORLD_IDKIT_ENVIRONMENT` (sandbox for local tests).
- **YouTube linking (optional):** set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (a Google OAuth
  client with YouTube Data API v3 enabled, redirect `https://localhost:3000/api/facevisa/youtube/callback`). Without
  them the Link button doesn't show.
- **Resetting:** `pnpm reset-local`, with the backend stopped, wipes the local database
  (`accounts/local/accounts.sqlite`).

Tests: `cd agents && pnpm test`. They cover:
- OIDC sign-in against a local identity provider;
- the in-app approvals (approve, reject, deny, expiry, ownership, CSRF, the spend step-up) over HTTP;
- the IDKit check (success, cancel, once-only, held for review, environments) against a fake World verify endpoint;
- the pipeline, the rules, persistence and Vertex safety;
- the real face matcher, when its models are present.

## Repository

| Path | What |
|---|---|
| `agents/src/app/` | the HTTP server: sign-in (`worldid.ts`, `session.ts`, the dev sign-in and demo identities in `standin.ts`), the IDKit check (`presence.ts`), in-app approvals (`approval.ts`), routes (`facevisaRoutes.ts`), accounts and creator profiles |
| `agents/archive/` | the dropped Agent Pass checkpoint and its tests (not compiled) |
| `agents/src/facevisa/` | the brand agent, creator rules, the data layer (SQLite, the authority), the pipeline (generate → face gate → approval → pay → release), the face gate |
| `agents/src/arkiv/` | Arkiv: the seven entity schemas, the Rabdi client and send guard, the outbox (writes) and the reads (shortlist, inbox, Verify) |
| `arkiv/` | for Arkiv's judges: [schema](arkiv/schema.md), [how we use it](arkiv/how-you-use-arkiv.md), [why Arkiv](arkiv/why-arkiv.md), [reach](arkiv/reach.md), [friction](arkiv/friction.md) |
| `agents/src/face/` | the local face matcher |
| `agents/src/ai/` | the per-media providers (`media.ts`), 0G (`zerog.ts`: Seedream images, Seedance video), Vertex AI (Gemini image, Veo video), the AI label, the banned-use filter |
| `web/` | Next.js: sign-in, the creator profile (capture, rules, requests, licences), the brand agent console, the request and spend pages, Verify |

## Security notes

- **Secrets stay on the server.** The OIDC client secret or key, the IDKit RP key, the session secret and all tokens never reach
  the browser, a URL, a log or git. The callback's query string is never logged.
- **The browser is never proof.** Only an ID token our backend obtained by code exchange and validated counts.
- **Request integrity:** POSTs must come from `PUBLIC_URL`'s origin, and every signed-in POST (approvals included)
  needs the session's CSRF token.
- **YouTube:** the Google access token is checked to be for our client and the `youtube.readonly` scope, used once
  in the backend to read the granting account's own channel, and never stored or sent to the browser.
- **Unreleased ads are private.** Only their signed-in creator can see them. The brand
  gets the file after release.
- **Proof of Presence:** each request is signed on the server with the RP key (read from a file, never sent to the
  browser). The browser's result counts only if it answers that request (single-use nonce, action, environment
  pinned to the server's: production, or the labelled sandbox on the dev database and the public demo), carries a Selfie Check bound to this account (signal hash), passes World's own verify
  endpoint, then has a `sybil_score` within our threshold and a nullifier not used before for the action.
- **Release:** gated by the exact approval binding, claimed once (one payment), and written in one transaction with
  unique keys, so one approval can never become two licences.

MIT licence ([LICENSE](LICENSE)).
