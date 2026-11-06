# Integration debrief: World ID (IDKit)

FaceVisa's World ID check, built for ETHGlobal Mumbai's "Best Use of IDKit": what we built, the time to first
success, the friction, what's missing in World's docs, and the one improvement with the most impact. Times are UTC
unless marked IST.

## IDKit

Proof of Presence (World ID's Selfie Check) through IDKit 4, before a creator's face is listed for paid licensing.
Why this credential, and every path: [README](README.md#world-id-idkit-proof-of-presence-before-a-face-is-listed).

### The debrief

**Time to first success**
- **Built and passing against a fake verify endpoint:** 9 minutes. Server-side signing, verify, the nullifier rule,
  the score threshold and the cancel paths were passing 9 minutes after we started.
- **First real proof (sandbox World ID app): 5 Nov 17:34 UTC.**
  - Nearly all the time before it went into finding an environment that would issue a credential (below).
  - From the first sandbox attempt (16:21 UTC): 1 h 13 min.
  - The proof itself: 26.2 s from signing the request to the result; World's verify answered in 1.4 s.
  - The credential was Proof of Human, requested on its own. A request that included Selfie Check stalled in the
    sandbox app.
- **Production:** none. The production World App offered only the Orb for our Selfie Check request.

**Friction**
1. **The production World App offered only the Orb** (5 Nov, ~07:35 UTC).
   - We asked for a Selfie Check (`selfieCheck` preset, IDKit 4.6), which the docs say needs no Orb.
   - The QR code opened Rohit's World App, which offered Orb verification and no selfie.
   - Nothing came back to IDKit: no proof and no error code (such as `credential_unavailable`). So our page couldn't
     tell the creator what happened.
2. **The Simulator has no Selfie Check.**
   - It issues only orb, device, document and secure_document credentials.
   - Its page says it "will change with the adoption of World ID 4.0".
   - So there's no phone-free way to test the one credential this prize centres on.
3. **Sandbox enrolment.**
   - The only documented Selfie Check test path is the sandbox World ID app: TestFlight, "gated behind an enrollment
     request" in the Developer Portal.
   - For a hackathon that means waiting on an approval before the first test.
4. **The sandbox error** (5 Nov): the first sandbox attempt ended with an error in the sandbox app.
   - Logged: one signed request, then the widget closed 147.7 s later (IDKit end code `closed`); no proof reached the
     backend.
   - Rohit reports it **fixed** the same day, on the World ID app's side. Nothing changed in our code.
5. **The wrong app opens the request** (5 Nov, 16:21 UTC).
   - With the production and sandbox World ID apps on one iPhone, scanning a sandbox QR code with the Camera opened
     an app that "couldn't find the request". IDKit reported `verification_rejected`.
   - Nothing in the docs says which app the Camera picks, or that a tester should scan from inside the sandbox app.
6. **Two portals for one product:** IDKit at developer.world.org, OIDC sign-in at auth.world.org/portal, not linked.

**Missing capability or documentation**
- **A Selfie Check in the Simulator,** with a settable `sybil_score`, so success, once-only and held-for-review can
  be tested without a phone.
- **What the World App does when it can't offer the requested credential.** In our test it switched to the Orb
  instead of returning an error the app could act on. The docs don't say which happens, or when.
- **Selfie Check availability:** by country, by app version, and for new users. Nothing says why a production app
  might not offer it.
- **The `sybil_score`:** its scale and a recommended threshold. We chose 3 of 10 and hold anything above it for
  review.
- **Whether v4 actions cap verifications per person.** IDKit has `max_verifications_reached`, and the credentials page
  says "Each user can complete that action once", but neither says it outright.

7. **Selfie Check is "Coming soon" in the sandbox** (5 Nov, 17:00 UTC).
   - The docs describe a full Selfie Check journey in the sandbox. Rohit's sandbox World ID lists "Proof of presence:
     Selfie: Coming soon", and the sandbox app stalls on our request without an error.
   - With production offering only the Orb and the Simulator having no Selfie Check, **no environment we could reach
     can issue the credential this prize centres on.**
   - Worse, **a request that merely includes Selfie Check stalls**, even as one option in `any()` alongside a
     credential the person holds. Only a request for Proof of Human alone completed. The app should pick the
     credential it can satisfy, or return `credential_unavailable`.

**The one improvement with the most impact**
- **When an app asks for a Selfie Check, the World App should either complete it or return
  `credential_unavailable` with a reason. It shouldn't switch to the Orb.**
  - A creator then gets a clear next step, and the app can offer its alternative path.
  - Today the request silently becomes one for a credential that's much harder to get.

### Tests A, B and C (local, sandbox, dev database)

The local backend: `WORLD_IDKIT_ENVIRONMENT=sandbox`, action `presence-test`, the stand-in for sign-in.

| Test | Expected | Result |
|---|---|---|
| A: success (`Rohit (PoP sandbox)`) | verified; listed with the "World ID sandbox" badge | **verified, 5 Nov 17:34 UTC.** Proof of Human only (see the diagnostics below). Signed → result 26.2 s; World verify HTTP 200 in 1,369 ms, `"environment":"sandbox"`, `"message":"Proof verified successfully"`; no `sybil_score` (Proof of Human carries none); integrity bundle v2 `apple_app_attest`. The page: "✓ Proof of Human (the Orb) from World ID's sandbox (a test identity, not production verification)" |
| B: cancel (`Rohit (IDKit B)`) | IDKit end code logged; stays Draft | **done** (Rohit): cancelled in the World ID app; "You cancelled in the World ID app. Nothing changed.", the profile stayed Draft |
| C: the same World ID on account B again | `nullifier_used` (or World's `max_verifications_reached`): "already listed" | **done, on the public demo, twice:** 5 Nov 19:00:39 UTC (a second account) and 6 Nov 07:04:31 UTC (a third). World's app refused before any proof reached us: IDKit code `nullifier_replayed`, 14.5 s and 17.5 s after signing; `[presence] … nothing changed`. The page said "This World ID has already completed the World ID check for FaceVisa: it's already listed under another account." |

For each, from the `[presence]` log: the times (request signed → result → World's answer), World's response, the
`sybil_score`, the environment and the labels shown.

### Log

- B6 built and tested against a fake World verify endpoint (10 new tests): server-side signing and verify; the
  nullifier unique per action; the `sybil_score` threshold; cancel and failure paths; required to list; the demo's
  action reserved for `facevisa-v1`.
- First real proof from the World ID app: **done, 5 Nov 17:34 UTC** (sandbox, Proof of Human; see the debrief above).
- Sign-in with World ID and Agent Pass were dropped (World's judge advised focusing on IDKit), so neither was run.

- 2026-11-05: what's built since.
  - **A high `sybil_score` is held for review,** not refused (World calls it "a risk signal, not a uniqueness verdict").
  - **Every step is logged** as `[presence]`: times, the shape of the result, World's answer in full with nullifiers
    redacted, the score and the environment.
  - **Sandbox and staging modes:** dev database only, labelled test identities, and a proof counts only in its own
    environment.
- 2026-11-05 ~07:35 UTC (13:05 IST): **first real attempt, production** (`presence-test`, dev database, stand-in
  sign-in).
  - The QR opened Rohit's regular World App, which offered **only the Orb**, not the selfie.
  - No proof came back: the backend logged signed requests and no result.
- 2026-11-05: **sandbox attempt** (the sandbox World ID app from TestFlight, `environment: sandbox`, `presence-test`).
  - One signed request; no proof reached the backend.
  - The widget was closed 147.7 s after the request was signed (logged as IDKit end code `closed`).
  - The sandbox app showed an error (not recorded); fixed later that day in the app (below).
- 2026-11-05: **set aside** for the feature freeze. The local configuration has Proof of Presence off.
- 2026-11-05: **the sandbox error is fixed** (Rohit). World's judge advised focusing on IDKit, so we submit to
  "Best Use of IDKit"; Agent Pass stays built but isn't submitted.
- 2026-11-05 15:57 UTC: local backend in sandbox mode (`presence-test`, dev database) for tests A, B and C. The
  first request was signed; no result yet.
- 2026-11-05 16:07–16:10 UTC: **the public demo uses the sandbox** (an allowed exception to the freeze).
  - **Two labelled listing paths:** "List with Proof of Presence (World ID sandbox)", and "Demo listing without World
    ID" ("Unverified demo creator").
  - **The brand agent** shortlists only creators with Proof of Presence unless the brand includes unverified ones.
  - **Sandbox labels** go on the badges, the shortlist, the Arkiv listing (`presence`) and the creator page.
  - **Guards:**
    - the server refuses sandbox outside the dev database and the public demo;
    - a proof counts only in its own environment;
    - the server database held no proofs before the switch.
  - **Tests:** 9 new, 210 passing.
  - **Health:** check passed.
- 2026-11-05 ~16:20 UTC: **test A, first tries** (local, sandbox, `presence-test`).
  - Attempt 1: the widget was closed 51.3 s after the request was signed (IDKit end code `closed`).
  - Attempt 2: the QR code was scanned with the **iPhone Camera**, which opened a World ID app. The app said:
    "Something went wrong. World ID App was opened to handle a request from another app or website, but we couldn't
    find the request." IDKit ended with `verification_rejected` 21.7 s after the request was signed, at 16:21:39 UTC.
    No proof reached the backend.
  - Likely cause: with both the production and the sandbox World ID apps installed, the Camera hands the link to one
    of them. A sandbox request can only be found by the sandbox app. Next try: scan from inside the sandbox app.
- 2026-11-05 16:51–17:00 UTC: **test A, scanned from inside the sandbox app.**
  - IDKit showed "Connecting… Please continue in app" (the app had fetched the request). The app then showed nothing.
  - Attempt `0x00a1a281…` waited 376.3 s before the widget was closed; the next, 33.5 s. No proof reached the backend,
    and the Developer Portal's `presence-test` page says "No verifications yet".
  - Checked:
    - the tester's enrolment (sandbox panel, iOS);
    - the sandbox app's account;
    - the camera permission;
    - a fresh request scanned from the app;
    - the action. `presence-test` has no environment setting in the portal: identifier, description, history, delete.
- 2026-11-05 17:00 UTC: **the cause: Selfie Check isn't available in the sandbox yet.**
  - Rohit's sandbox World ID, on sandbox.auth.world.org (banner "Sandbox: Uses fake identities"):
    - "Proof of human: Connected", last verified 05/11/2026, via the sandbox app;
    - "Proof of presence: Selfie: **Coming soon**".
  - So the sandbox app has no credential that can answer a `selfieCheck` request. It fetches the request and shows
    nothing, with no IDKit error such as `credential_unavailable`.
  - World's "Testing Selfie Check in Sandbox" page says the sandbox runs "the full Selfie Check relying-party journey
    end-to-end".
- 2026-11-05 17:05 UTC: **Selfie Check OR Proof of Human** (Rohit's decision).
  - The request is IDKit's `any(CredentialRequest("selfie"), CredentialRequest("proof_of_human"))`.
  - The server accepts either:
    - Selfie Check (schema 11): needs its integrity bundle and `sybil_score`;
    - Proof of Human (schema 1): no score, so never held for review.
  - The credential is stored and labelled: badge, shortlist, Arkiv listing (`credential`), creator page.
  - Old databases are rebuilt with every proof kept. 213 tests pass.
- 2026-11-05 17:11–17:18 UTC: **test A with either credential: the same stall.**
  - IDKit debug log: "Creating flow handle…", then "Flow created", request ID `717f00a6-b173-46bf-8240-a84b4d39ec6e`.
  - The sandbox app opened ("Connecting… Please continue in app") and showed nothing. No proof came back, though
    Rohit's sandbox World ID shows "Proof of human: Connected" (verified today with the same app).
  - So the stall isn't only the missing Selfie Check. The sandbox app fetches the request and fails silently. Our page
    sends no Content Security Policy; the `eval` warning in Chrome's Issues panel comes from elsewhere.
  - Next: report it to World's sandbox support with the request IDs.
- 2026-11-05 17:30–17:35 UTC: **sandbox diagnostics** (Rohit's request; local only, behind a development-build switch,
  removed afterwards).
  - **1. Proof of Human only** (`CredentialRequest("proof_of_human")`, no `any()`, `allow_legacy_proofs: false`):
    - the sandbox app showed the prompt; Rohit approved it;
    - **verified**: request `9ffc2fda-b6a6-4f20-9c18-4e4f0d763d46`, attempt `0x007d4e5e…`;
    - 26.2 s from signing to the result;
    - the result: protocol 4.0, sandbox, `presence-test`, one `proof_of_human` response (schema 1), integrity bundle
      v2 `apple_app_attest`.
  - **World's verify:** `POST /api/v4/verify/rp_6b85f4fba98bcdb4` returned HTTP 200 in 1,369 ms:

    ```json
    {"success":true,"action":"presence-test","nullifier":"[redacted]","created_at":"2026-11-05T17:34:30.478615+00:00","environment":"sandbox","protocol_version":"4.0","results":[{"identifier":"proof_of_human","success":true,"nullifier":"[redacted]"}],"message":"Proof verified successfully"}
    ```
  - **Stored:** nullifier for `presence-test`, credential `proof_of_human`, sandbox. The creator may list.
  - **2. With `allow_legacy_proofs: true`:** not needed. The sandbox's Proof of Human answers as World ID 4.0.
  - **Finding:** the sandbox app stalls silently on any request that includes Selfie Check, even inside `any()` with a
    credential it holds. A request for Proof of Human alone works.
  - **Our log's "credential valid until"** prints `expires_at_min`, which equals the request time. It's the minimum
    expiry we asked for (none), not the credential's real expiry.
- 2026-11-05 17:40 UTC: **final config** (Rohit's decision after the diagnostics), live as release `20261105-174029`,
  health check passed.
  - **Credentials asked for** (the server sends them with each signed request; the page follows):
    - World's sandbox: Proof of Human alone;
    - production: Selfie Check or Proof of Human.
  - The diagnostic switch is removed.
  - **The sandbox flow is labelled:**
    - "List with World ID (sandbox: Proof of Human)";
    - "Share Proof of Human with World ID (sandbox)";
    - the badge "Proof of Human (World ID sandbox)".
  - Messages say "the World ID check" where either credential counts. 213 tests pass.
- 2026-11-05 ~18:00 UTC: **World ID only as the IDKit check** (Rohit's decision).
  - **Sign-in** no longer uses World ID:
    - the local stand-in is now "Dev sign-in" (identity `dev`);
    - the public demo keeps its demo identities;
    - World ID sign-in stays in the code behind `WORLDID_SIGNIN=1`, off by default.
  - **Agent Pass is dropped.** The checkpoint code and its tests moved to `agents/archive/`.
  - **Approvals are in-app,** by the signed-in person:
    - the creator approves the exact ad, bound to the file hash the page showed plus the brand, usage, duration and
      price, once;
    - the brand approves a spend over $0.10 for the exact amount;
    - deny, expiry and cancel release nothing; release without the approval is 403.
  - **Labels:** "approved by the creator in FaceVisa", "spend approved by the brand"; Arkiv's `identity` is `dev` or
    `demo`.
  - **Checks:**
    - 197 tests pass, including 12 new approval tests;
    - `e2e:live` passed against the local app on Arkiv dev (licence `lic_3f5445db071aec09`);
    - deployed as release `20261105-180147`; health passed;
    - the live site has World ID sign-in off, and the seeded video's Verify answer says "approved in FaceVisa" with
      identity `demo`.
- 2026-11-05 ~18:57 UTC: **the World ID check required of creators and brands** (Rohit), live as release
  `20261105-185646`.
  - "Demo listing without World ID" and the brand's "include unverified" toggle are removed.
  - One check per account covers both workspaces.
  - A brand can't shortlist or request ads before it (`presence_required`).
  - The agent skips listings without a check.
  - Sign-in on the public site is now Google; the demo identities are retired.
- Done since: tests B (cancel) and C (the same World ID refused on a second account, live on the public demo), and
  the first real check on the public demo (5 Nov 18:07 UTC, sandbox, Proof of Human).
- Still open: a production Selfie Check, which waits on the World App offering the selfie.

Friction noted from the docs (before any live test):
- **Two portals for one product.** IDKit apps live at developer.world.org (app_id, rp_id, signing key, actions). The
  OIDC sign-in client lives at auth.world.org/portal. Nothing links them, and a Proof of Presence made through one
  never names the other.
- **A chicken-and-egg for new users.** OIDC sign-in needs a credential, and Proof of Presence is started by an app.
  So a person with only the World App can't sign in until some app has asked for a Selfie Check. Our first check
  has to come from a test session.
- **The docs don't say:**
  - whether v4 actions cap verifications per person (IDKit has `max_verifications_reached`; the credentials page says
    "Each user can complete that action once");
  - which origins or redirects to register (none, as far as we can tell);
  - whether the credential from an IDKit Selfie Check is the same one sign-in uses.

From our research before building: the docs describe no phone-free way to test Selfie Check
(Proof of Presence). The Sandbox needs the sandbox World App via TestFlight. The Simulator hasn't caught up with World
ID 4.0, and "mocked proofs" isn't in the public docs.
