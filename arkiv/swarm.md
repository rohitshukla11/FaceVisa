# Swarm and Arkiv in FaceVisa

FaceVisa licenses creators' faces to AI ads. **Swarm keeps the ad files; Arkiv keeps the public record of each deal and
points at the file.** Every ad released after 6 Nov 2026 is uploaded to Swarm once, and its Arkiv receipt carries the
Swarm reference. Anyone holding the file can check, in their browser, that it's the one the receipt describes.

## When it was built

All of the Swarm work was built during the hackathon, on 6 Nov 2026. Before that, FaceVisa kept ad files on its own
server, and its Arkiv receipts carried only the file's sha256. Built on 6 Nov:
  - our own Bee node, funded from an event gift, and the postage batch;
  - the upload of every released ad: showcase ads as they are, all others encrypted with their key sealed to the
    brand and the creator;
  - `swarm_ref` and `swarm_encrypted` on the Arkiv receipt;
  - reading an ad back from Swarm (and decrypting it for its brand or creator) once the server's copy is gone;
  - the Swarm check in the public verifier, and "On Swarm ↗" beside every ad in the app.

## What lives where

| | On Swarm | On Arkiv |
|---|---|---|
| The ad file (image or 8 s video) | ✓ (showcase ads as they are; all other ads encrypted) | never: only its sha256 |
| Who licensed what, for how long, at what price | | ✓ `licence` (owned by the creator's key) |
| Proof the ad was released, how it was made and paid | | ✓ `receipt` (read-only, FaceVisa's receipt key) |
| **The pointer from the record to the file** | | ✓ **`receipt.swarm_ref`** (64 hex digits) and `receipt.swarm_encrypted` (bool) |
| The key that opens an encrypted ad | | never: sealed to the brand and the creator, kept in FaceVisa's database |

**Two kinds of upload:**
- **Showcase ads** (the founder's own, consented: `SWARM_SHOWCASE_CREATORS`) are uploaded as they are. Their reference
  opens in any browser through the public gateway, and the bytes hash to the receipt's `file_hash`.
- **Every other ad is encrypted before it leaves our server:** AES-256-GCM with a fresh key per file. Swarm stores
  ciphertext, and `swarm_ref` is the plain content address of that ciphertext, so publishing it on Arkiv reveals
  nothing. The file's key is sealed (ECDH on secp256k1, then AES-256-GCM) to the brand's and the creator's account
  keys. When the public demo deletes its own copy after 48 hours, the brand and the creator still open the ad in the
  app: it's read back from Swarm and decrypted with their key.
- **We never use Swarm's built-in encryption for anything that reaches Arkiv:** its 128-hex references carry their
  decryption key. The uploader refuses any reference that isn't 64 hex digits, and the verifier ignores one.

## One entity and the file it points to

A showcase ad (an image) released on 6 Nov 2026, namespace `facevisa-public`:
- **Arkiv receipt entity:** [`0x52ae1e9ce8a5476e2169dae1216da9849e02f62c97f9632b2a62b3045f1f9e37`](https://rabdi.explorer.arkiv.network/entity/0x52ae1e9ce8a5476e2169dae1216da9849e02f62c97f9632b2a62b3045f1f9e37)
  (read-only, owned by FaceVisa's receipt key `0x9625c5E37D8826cD9459DAffb7Bb78999CBf00cA`)
- **`swarm_ref`:** `6ae57247f0d306e4543917cbd7e72cb8a1080d58fc45bd3b1192cc02214f3a77`, `swarm_encrypted: false` →
  [open the file on Swarm](https://api.gateway.ethswarm.org/bzz/6ae57247f0d306e4543917cbd7e72cb8a1080d58fc45bd3b1192cc02214f3a77/)
- **`file_hash`:** `0x45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220`. The file the gateway serves hashes to exactly this.
- The licence it's released under: [`0xccc7e19a701942ed3c83ca3bdd3cce3cc2bcd77b6a841973e1c8bc7506b68783`](https://rabdi.explorer.arkiv.network/entity/0xccc7e19a701942ed3c83ca3bdd3cce3cc2bcd77b6a841973e1c8bc7506b68783);
  the USDT payment on Whitechain: [`0x1508d442…`](https://explorer.testnet.whitechain.io/tx/0x1508d44255adce49f1e7b108f141f9bbfbbc5f1d4e5d27f1175238af37dc8432).

## Postage, wallet and node

- **Batch ID:** `78f615454a8ead07873a5d603c7b59e002a75a31b95b8bb6990907ab6496f794`: immutable, depth 18, label `facevisa-ads`, bought 6 Nov 2026 at 15:16 UTC (Gnosis block
  49141096, [tx](https://gnosisscan.io/tx/0x2cb90bd95fd3d72886a0c6e0cb4aa42b6d94e219b93bb36eb4364bc6d9ff0c61)) for
  about 0.70 xBZZ; paid for about 7.7 days, so files stay up until about 14 Nov 2026.
- **Bought by:** FaceVisa's Bee node wallet [`0x965FCce7D580C439F9b59D1E366b4c35A5C9f0Ae`](https://gnosisscan.io/address/0x965FCce7D580C439F9b59D1E366b4c35A5C9f0Ae)
  on Gnosis, funded from an event gift (10 xBZZ, 0.01 xDAI): [xBZZ](https://gnosisscan.io/tx/0xf86f69251db81acbca84ab5ec64427cd69e90bc50a155c08e86f2ccfdc0ae3f9),
  [xDAI](https://gnosisscan.io/tx/0x44a8c14569db1bce5c8cba9470fd467c67b036fbe8cb8a614709287e6b772ca3). Chequebook:
  `0xDe72F48Fb5A44f443574734aa9e120917E576E77`.
- **Bee node:** our own Bee 2.8.2 light node (checksum-verified release binary) on the FaceVisa server, Gnosis mainnet,
  API only on `127.0.0.1:1633` (systemd `facevisa-bee`).
- **Reads:** Swarm's public gateway, `https://api.gateway.ethswarm.org`.

## The code

| File | What it does |
|---|---|
| [`agents/src/swarm/swarm.ts`](../agents/src/swarm/swarm.ts) | Uploads each released ad to Bee (`POST /bzz`, the batch, `swarm-deferred-upload: false`); encrypts private ads and seals their key; reads a file back and decrypts it for its brand or creator; the node's health and the batch's time left |
| [`agents/src/arkiv/schema.ts`](../agents/src/arkiv/schema.ts), [`outbox.ts`](../agents/src/arkiv/outbox.ts) | `swarm_ref` and `swarm_encrypted` on the read-only receipt; the receipt waits up to 15 minutes for its file's upload |
| [`agents/src/app/runtime.ts`](../agents/src/app/runtime.ts) | Queues every newly released ad for Swarm before Arkiv hears of its receipt |
| [`agents/src/app/facevisaRoutes.ts`](../agents/src/app/facevisaRoutes.ts) | Serves an ad from Swarm (decrypted for its brand or creator) once the server's own copy is gone; Verify shows the file's Swarm state |
| [`web/public/verifier/verify.js`](../web/public/verifier/verify.js) | The public verifier: reads `swarm_ref` from the Arkiv receipt, fetches the file from the gateway, and checks its sha256 in the browser |

## Run one upload and one read yourself

**A read** needs nothing but a browser or `curl`:
1. Get a receipt's Swarm reference from Arkiv's public endpoint (no key):
   ```sh
   curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d @- <<'EOF'
   {"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["app = str('facevisa-public') AND type = str('receipt') AND file_hash = str('0x45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220')",
     {"select":{"key":true,"owner":true,"attributes":{"swarm_ref":true,"swarm_encrypted":true}},"limit":"0x1"}]}
   EOF
   ```
   You should see the receipt above with `swarm_ref` `6ae57247f0d3…` and `swarm_encrypted` `false`.
2. Fetch the file and hash it:
   ```sh
   curl -s https://api.gateway.ethswarm.org/bzz/6ae57247f0d306e4543917cbd7e72cb8a1080d58fc45bd3b1192cc02214f3a77/ -o ad && shasum -a 256 ad
   ```
   You should see `45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220`, the receipt's `file_hash` without `0x`.
3. Or open the [direct verifier](https://facevisa.site/verifier/index.html), paste `0x45b8257f6ef87ccd18ce809e002d93e3c432e2c5b8b910f5b4a35082c79fa220`: Licensed, and
   "On Swarm: open the file ↗ ✓ same bytes as this file".

**An upload** needs a Bee node with a usable postage batch:
```sh
curl -s -X POST "http://127.0.0.1:1633/bzz?name=ad.jpg" -H "swarm-postage-batch-id: <batch id>" \
  -H "content-type: image/jpeg" -H "swarm-deferred-upload: false" --data-binary @ad.jpg
```
You should see `{"reference":"<64 hex digits>"}`, then the same file at `https://api.gateway.ethswarm.org/bzz/<reference>/`.
In FaceVisa this happens on its own: approve an ad, and within a minute its receipt on Arkiv carries `swarm_ref`.

## In the demo video

The demo video is on our [ETHGlobal project page](https://ethglobal.com/showcase/facevisa-m5ee9). The Swarm moment: we approve a showcase ad as the creator, open Verify, and follow "On Swarm ↗": the
gateway shows the same ad, and the verifier marks it "✓ same bytes as this file". Then we open the receipt on the
Arkiv explorer and point at `swarm_ref`.

## What got in our way

- **33 gift codes, all already swept.** A list marked "Unclaimed" had been redeemed weeks earlier into one wallet;
  checking each code's balance on Gnosis before using it saved us from a failed setup. A fresh code from the event
  worked.
- **A light node's first start:** after funding, it deploys a chequebook, then syncs about 9 million blocks of postage
  history before it accepts uploads (about 20 minutes on our server).
- **Thin xDAI:** the gift carried 0.01 xDAI. Gnosis gas was low enough that it covered the funding transfers, the
  chequebook and the batch.
- **Encrypted references carry their key.** We had to keep Swarm's own encryption off anything published, and encrypt
  ourselves instead, so the reference on Arkiv is safe to share.
