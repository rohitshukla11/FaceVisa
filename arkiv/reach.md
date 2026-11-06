# Reach

## Who is it for, and would they use it?

FaceVisa is for the two sides of one deal:
- **Creators:** people whose face brands want in ads, who want to be paid for it and to approve each ad themselves.
- **Brands, and the AI agents working for them:** they want a real person's face in an ad, with proof of consent
  instead of a deepfake and legal risk.

**Users today.** FaceVisa runs as a public demo at **https://facevisa.site** (testnet, Google sign-in), live since
5 Nov 2026. Its own database, on 6 Nov at 18:30 UTC:

| | |
|---|---|
| Accounts | 9 (two of them seeded synthetic demo creators, labelled so) |
| Creators listed | 3 |
| Brand workspaces that requested ads | 2 |
| Ads released | 6: the 3 in the main flow paid in USDT on Whitechain (0.25 USDT in all), and 3 earlier test releases |
| Licences | 5 active, 1 revoked by its creator |
| World ID checks | 1 (Proof of Human, World ID sandbox) |

These are our own test accounts. FaceVisa was built during the hackathon, so nobody outside the team has used it
yet.

**Why we think they'd use it.** Before building it, we spoke with brands and creators. Both told us the same thing:
organising a shoot is a hassle. FaceVisa removes the shoot: a creator lists their face once, with their own price and
rules, and approves each finished ad; a brand's agent gets the ad made without a set, and pays the creator directly.

**They already use the Arkiv part, because it isn't optional.** Every listing, licence, receipt and revocation goes to
Arkiv when it happens, and these screens read from it:
- **Brands' agents:** every shortlist is Arkiv's query of the listings that fit the brief, with each creator's stats
  (ads approved, active licences, earned, brands) from their own `creator_stats` entity.
- **Creators:** their inbox of ads waiting for approval is read from Arkiv, and their dashboard links their stats
  entity and their public "where is my face used" page.
- **Anyone holding an ad:** Verify and the direct verifier answer from Arkiv alone, without an account. The verifier
  also checks the payment on Whitechain and the file on Swarm.
- **Creators checking where their face is used:** the public creator page lists every licensed ad of one creator
  from Arkiv. Instagram influencers who do brand shoots, friends of Rohit, told us they'd use it.

## Can they try it today?

Yes, with nothing to install:
- **The app:** https://facevisa.site. Sign in with Google; one account has a creator profile and a brand workspace.
  A brand's agent shortlists creators, makes the ad, the creator approves it, and the USDT payment settles on
  Whitechain testnet.
- **Check an ad:** [one showcase ad](https://facevisa.site/verifier/index.html?ns=facevisa-public&hash=0x45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220):
  Licensed, paid, and the same bytes on Swarm.
- **Where a face is used:** [Rohit's page](https://facevisa.site/verifier/creator.html?creator=0xe668c0adec9ee9e104256e35d20ef586c1e136d9&ns=facevisa-public),
  read from Arkiv in your browser.
- **From a terminal:** the README's `curl` query lists every released ad's receipt.
- **Locally:** the README's "Run it" section; the whole flow runs with a dev sign-in and test renders.

What's not real yet, and labelled so everywhere: World ID checks are from World ID's sandbox (its production app
offered us only the Orb), and payments are testnet USDT.

## Will we keep building it after Mumbai?

**Yes.** Rohit will keep building FaceVisa after Mumbai and turn it into a full product, with his team of
developers.
- **Next:** a launch to a limited group of users soon, starting with the Instagram creators who asked to use it.
- **Arkiv stays FaceVisa's public record for good:** every listing, licence, receipt and revocation keeps going to
  Arkiv, so anyone can check a licence without asking us.

What already points that way:
- **The Arkiv integration is production-shaped, not demo code:**
  - the outbox survives restarts and never writes twice;
  - writes follow Arkiv's write-safety rules;
  - reads fall back, labelled, when Arkiv is unreachable;
  - namespace guards keep demo and real data apart (`facevisa-v1` is reserved for real World ID data);
  - the whole lifecycle (revoke, unlist, renewal, expiry, stats deletion) has run live on Rabdi.
- **The open items for a real launch:**
  - letting creators take their entities to their own wallet (`changeOwnership`);
  - renewing receipts past ~182 days;
  - moving from custodial keys to keys users hold;
  - a production World ID check (Selfie Check) once World's app offers it.
