# Why Arkiv

> The runs below wrote to earlier namespaces; those entities and their explorer links are unchanged. From
> 6 Nov the namespaces are `facevisa-dev`, `facevisa-public` and `facevisa-v1`.

FaceVisa's records are promises about a real person's face: this brand may use this exact file, for this long,
because this creator said yes. Kept only in FaceVisa's database, checking them would mean asking FaceVisa, and
trusting its answer.

## If we swapped Arkiv for Postgres or any other database, what would users lose?

1. **Anyone checks a licence without asking FaceVisa.**
   - A publisher, a platform's moderation team, or the creator's lawyer has a file. They drop it on the direct
     verifier (`/verifier/index.html`), a static page that never calls FaceVisa:
     - it hashes the file in their browser;
     - it asks Arkiv's public endpoint for the receipt FaceVisa's receipt address wrote, then for the licence the
       creator's key owns;
     - it shows status, end date, and how consent was checked.
   - No account, no access key, no API of ours. The page also works opened from disk. The README's `curl` does the
     same in one call.
   - It keeps working if FaceVisa is down or gone. Even after a licence entity expires, the receipt still says when
     it ended.
   - In SQLite they would need our Verify page and would have to trust what it says.
2. **Nobody can quietly rewrite a licence or a receipt, FaceVisa included.**
   - A receipt is read-only: once written, the file, the licence it points to, the model and the payment reference
     are fixed.
   - A licence can only be patched by the creator's key, and the only change we ever make is `revoked`, which is
     visible to anyone.
   - In SQLite an admin with database access can edit both and leave no trace.
3. **The end of a licence is enforced by Arkiv, not by our cron.**
   - The licence entity expires at the licence's end and is deleted. Verify, from Arkiv, then says "Licence expired
     on <date>".
   - An unanswered request disappears when its review window ends. A listing lapses unless it's renewed while its
     creator stays listed.
   - With Postgres, "expired" is whatever our code decides when it runs.
   - Watched live: a 4-minute licence was gone from Arkiv's queries about a minute after its end, and both
     readers switched to "Licence expired on 08:59:55" ([how-you-use-arkiv.md](how-you-use-arkiv.md#the-lifecycle-facevisa-dev-4-nov-0856-0901-utc)).
4. **Creators' offers are readable by any agent, not only ours.**
   - Listing entities carry exactly what an agent needs to filter on: price, longest licence, refused categories.
   - Another brand's agent can query them directly: `status=listed`, `banned_fitness=false`, `price<=…`.
   - In our database, only our agent can.
5. **A creator's track record is theirs, and anyone can check it.**
   - Each creator's `creator_stats` entity, owned by their own key, says how many ads they've approved, how many are
     active, how many they revoked, what they've earned in USDT and from how many brands. Brands have `brand_stats`
     the same way.
   - The public creator page and the direct verifier show it as a header, read from Arkiv in the browser.
   - Another marketplace, or a brand's own agent, can rank creators by it without asking us:
     `ads_approved > u64(5)` ([runnable query](schema.md#query-the-stats-yourself)).
   - In our database, a creator's history would be ours to show, hide or lose.

**What's honest to add:**
- **Ownership is custodial today.** FaceVisa holds one encrypted key per account, so point 2 protects against edits
  from any other key, not against FaceVisa itself as the key holder.
- **The path to self-custody is `changeOwnership`.** The creator's custodial key transfers their listing and licences
  to a wallet they hold, and from then on only they can revoke. The protocol allows it today. Our app doesn't offer
  it yet, and our readers would then accept the creator's declared wallet as the owner
  ([how-you-use-arkiv.md](how-you-use-arkiv.md#who-can-edit-each-entity)).
- **A revocation outlives the licence, in its own record.** On revoke, the creator's key writes a read-only revocation
  entity that lives ~182.5 days. So "Revoked on <date>" is still answered after the licence entity has expired
  ([friction.md](friction.md) #8).

## What we kept off Arkiv, and why

| Kept off | Why |
|---|---|
| The creator's live capture and photos | Biometric data. Stored only with consent, on our server, never public. |
| The ad files themselves | Unreleased ads are private to the creator until approval, and released ones are the brand's asset. Arkiv holds the file's sha256, enough to verify a copy, and the receipt's `swarm_ref` points to the file on Swarm: as it is for a showcase ad, encrypted for every other one, with its key sealed to the brand and the creator and never on Arkiv ([swarm.md](swarm.md)). |
| The brief text and the prompt | A brand's campaign plans. Arkiv holds `brief_hash` (sha256 of brief, usage, kind, price, duration), so the approval can still be checked against what was asked. |
| World ID subjects, issuers and checkpoint evidence | Identifiers that would link a person across apps. Arkiv holds only the label (`identity = world-id \| standin \| dev`), so nobody can mistake a test identity for World ID. |
| Emails, names of brands, YouTube data, the YouTube channel face match | Personal or not needed to verify. The only name on Arkiv is the display name a creator chose for their public listing. The face gate's result on a released ad (passed, and its score) is on the receipt: it's provenance of that file, not data about the person. |
| Payments | They settle in USDT on Whitechain testnet, through FaceVisaSettlement. Arkiv holds the reference (the settlement's transaction hash) and the paying wallet, not balances; Whitechain is where `LicensePaid` is checked. Earned and spent totals are on the stats entities, so anyone can see them without a block explorer. |
| Private keys | In an encrypted keystore (scrypt + AES-256-GCM), never in env, logs or entities. |
| Sessions, rate limits, AI-call caps, the brand agent's log | Operational state with nothing for anyone else to check. |

The rule we follow: Arkiv gets what someone outside FaceVisa needs to check a deal, as hashes and addresses, and
nothing that identifies or exposes a person or a brand's plans.
