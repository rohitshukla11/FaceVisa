/*
 * FaceVisa direct verifier: checks a file's licence on Arkiv alone, from the browser.
 *
 * It talks only to Arkiv's public JSON-RPC endpoint, with no access key and no call to FaceVisa. The file is hashed
 * here (SHA-256); only its hash is sent. Trust comes from ownership, which Arkiv enforces:
 *   1. the receipt for this file hash must be owned by FaceVisa's published receipt address;
 *   2. its licence must be owned by the creator address the receipt names (the creator's own entity);
 *   3. a revocation record owned by that creator means "Revoked on <date>": checked first, since it outlives the
 *      licence entity;
 *   4. otherwise the licence's status and expiry say whether it is in force. Arkiv deletes an expired entity, so a
 *      receipt whose licence is gone reads "Licence expired on <date>", the end the receipt records.
 *   5. a payment on Whitechain (rail "whitechain") is checked on Whitechain's public JSON-RPC: the receipt's
 *      transaction succeeded and FaceVisa's settlement contract emitted LicensePaid for this exact file, to the creator the
 *      receipt names, for the licence's price in USDT (and, while the licence entity remains, from its brand). If the RPC
 *      can't be reached, it says so and links the Whitechain explorer instead.
 *   6. an older payment over x402 on Hedera (rail "hedera-x402 (testnet)") is checked on Hedera's public mirror node: the
 *      receipt's transaction succeeded and moved exactly the licence's price in USDC from the brand to the creator.
 *      Each FaceVisa account's Hedera account has its Arkiv address as its EVM alias, so the brand and creator the
 *      entities name resolve to their Hedera accounts there. If the mirror node can't be reached from the browser,
 *      it says so and links HashScan instead.
 *
 * A classic script (not a module) so the page also works opened from disk; it defines window.FaceVisaVerifier.
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    rpcUrl: "https://rpc.rabdi.db-chain.testnet.arkiv.network",
    explorerUrl: "https://rabdi.explorer.arkiv.network",
    namespace: "facevisa-public",
    receiptAddress: "0x9625c5E37D8826cD9459DAffb7Bb78999CBf00cA",
    mirrorUrl: "https://testnet.mirrornode.hedera.com",
    usdc: "0.0.429274",
    whitechainRpc: "https://rpc.testnet.whitechain.io",
    whitechainExplorer: "https://explorer.testnet.whitechain.io",
    settlement: "0x8fbbca9e637c6261386e38dfef016a7dd90fc65b",
  };
  // The deployment's namespace (config.js), when the page sets one: only a valid namespace, nothing else.
  // (LIKENESS_VERIFIER_DEFAULTS: legacy, still read.)
  var pageDefaults = root.FACEVISA_VERIFIER_DEFAULTS || root.LIKENESS_VERIFIER_DEFAULTS;
  var configured = pageDefaults && pageDefaults.namespace;
  if (typeof configured === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(configured)) DEFAULTS.namespace = configured;
  var HEDERA_RAIL = "hedera-x402 (testnet)";
  var WHITECHAIN_RAIL = "whitechain";
  // keccak256("LicensePaid(bytes32,string,address,address,uint256)")
  var LICENSE_PAID = "0x0a016f4e8051c043d3530d2cb5957e9868a3bd6999f4e87027e4c509f22915a3";

  var HASH = /^0x[0-9a-f]{64}$/;
  var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;
  var KEY = /^0x[0-9a-fA-F]{64}$/;
  var TX_ID = /^0\.0\.\d{1,12}@\d{1,12}\.\d{1,9}$/;

  function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  /** SHA-256 of a file's bytes, as FaceVisa records it: 0x + 64 hex digits. */
  async function sha256Hex(data) {
    var buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    return "0x" + hex(new Uint8Array(await root.crypto.subtle.digest("SHA-256", buf)));
  }

  /** One JSON-RPC call; also returns the rate-limit header the public endpoint sends. */
  async function rpc(cfg, method, params, fetchFn) {
    var res = await fetchFn(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) });
    var rateLimit = res.headers && res.headers.get ? res.headers.get("ratelimit") : null;
    if (res.status === 429) throw new Error("Arkiv's public endpoint is rate-limiting this address: wait a few seconds and try again");
    if (!res.ok) throw new Error("Arkiv answered HTTP " + res.status);
    var body = await res.json();
    if (body.error) throw new Error("Arkiv: " + (body.error.message || "error"));
    return { result: body.result, rateLimit: rateLimit };
  }

  /** An entity's attributes by name: u64 as numbers, everything else as given (addresses lower-cased). */
  function attrs(entity) {
    var out = {};
    (entity.attributes || []).forEach(function (a) {
      out[a.name] = a.type === "u64" ? Number(BigInt(a.value)) : typeof a.value === "string" && a.type === "addr" ? a.value.toLowerCase() : a.value;
    });
    return out;
  }

  var RECEIPT_COLUMNS = { app: true, type: true, file_hash: true, licence_key: true, creator: true, licence_expires_at: true, licence_id: true, provider: true, model: true, job_id: true, payment_ref: true, payment_rail: true, payer: true, face_check: true, face_score: true };
  var LISTING_COLUMNS = { app: true, type: true, display_name: true, presence: true, credential: true };
  var REVOCATION_COLUMNS = { app: true, type: true, licence_key: true, file_hash: true, creator: true, revoked_at: true, licence_id: true };
  var LICENCE_COLUMNS = { app: true, type: true, output_hash: true, creator: true, brand: true, usage: true, kind: true, duration_days: true, price: true, status: true, identity: true, licence_id: true, approved_at: true };

  function query(cfg, where, columns, fetchFn, limit) {
    return rpc(cfg, "arkiv_query", [where, { select: { key: true, owner: true, expiresAt: true, attributes: columns }, limit: "0x" + (limit || 10).toString(16) }], fetchFn);
  }

  /** A payment, in words: DevPayment's are tests, labelled like a test identity. */
  function paymentLabel(rail, ref) {
    if (rail === "dev" || (!rail && /^dev-/.test(String(ref || "")))) return "test payment (no money moved)";
    if (rail === WHITECHAIN_RAIL) return "USDT on Whitechain testnet";
    if (rail === HEDERA_RAIL) return "USDC on Hedera testnet, over x402";
    return rail ? rail + " payment" : "payment";
  }

  /** 0.0.x@seconds.nanos (the SDK's form) as the mirror node's 0.0.x-seconds-nanos. */
  function mirrorTxId(id) {
    return String(id).replace("@", "-").replace(/\.(\d+)$/, "-$1");
  }

  /**
   * The payment, checked on Hedera's mirror node: the transaction succeeded, and moved `amount` (USDC's smallest
   * units, = micro-USD) of USDC from the brand's account to the creator's, each resolved from its Arkiv address.
   * state: "confirmed" | "mismatch" | "not-found" | "unreachable". Never throws.
   */
  async function hederaPayment(cfg, fetchFn, p) {
    var base = cfg.mirrorUrl.replace(/\/$/, "") + "/api/v1";
    var out = { rail: "hedera", source: "Hedera's mirror node", endpoint: cfg.mirrorUrl, where: "HashScan", txId: p.ref, hashscan: "https://hashscan.io/testnet/transaction/" + p.ref, checks: [], requests: 0 };
    // Only a Hedera transaction id goes into a mirror-node path or a HashScan link.
    if (!TX_ID.test(String(p.ref))) return Object.assign(out, { hashscan: "https://hashscan.io/testnet", link: "https://hashscan.io/testnet", state: "mismatch", checks: [{ ok: false, text: "the receipt's payment reference isn't a Hedera transaction id" }] });
    out.link = out.hashscan;
    var get = async function (path) {
      out.requests++;
      var res = await fetchFn(base + path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("the mirror node answered HTTP " + res.status);
      return res.json();
    };
    try {
      var t = await get("/transactions/" + mirrorTxId(p.ref));
      var tx = t && t.transactions && t.transactions[0];
      if (!tx) return Object.assign(out, { state: "not-found" });
      out.result = tx.result;
      out.consensusAt = Math.round(Number(tx.consensus_timestamp) * 1000);
      var account = async function (evm) {
        if (!evm) return null;
        var a = await get("/accounts/" + evm);
        return a && a.account;
      };
      out.payer = await account(p.brand);
      out.payee = await account(p.creator);
      var moved = (tx.token_transfers || []).filter(function (x) { return x.token_id === cfg.usdc; });
      var of = function (acct) { return moved.filter(function (x) { return x.account === acct; }).reduce(function (n, x) { return n + Number(x.amount); }, 0); };
      out.checks.push({ ok: tx.result === "SUCCESS", text: "the transaction succeeded on Hedera (" + tx.result + ")" });
      if (out.payee) out.checks.push({ ok: of(out.payee) > 0 && (p.amount === null || of(out.payee) === p.amount), text: "the creator's Hedera account " + out.payee + " received " + of(out.payee) / 1e6 + " USDC" + (p.amount === null ? "" : " (the licence's price: " + p.amount / 1e6 + ")") });
      else out.checks.push({ ok: false, text: "the creator's address (" + p.creator + ") has no Hedera account" });
      if (p.brand) out.checks.push({ ok: !!out.payer && p.amount !== null && of(out.payer) === -p.amount, text: out.payer ? "the brand's Hedera account " + out.payer + " paid it" : "the brand's address (" + p.brand + ") has no Hedera account" });
      else out.checks.push({ ok: true, text: "the licence entity has expired, so the payer and amount aren't checked" });
      out.amount = out.payee ? of(out.payee) : null;
      out.state = out.checks.every(function (c) { return c.ok; }) ? "confirmed" : "mismatch";
      return out;
    } catch (e) {
      return Object.assign(out, { state: "unreachable", error: e && e.message ? e.message : String(e) });
    }
  }

  /** A 32-byte word of hex (no 0x) as an address, or null if its top 12 bytes aren't zero. */
  function wordAddress(word) {
    word = String(word || "").replace(/^0x/, "").toLowerCase();
    return /^0{24}[0-9a-f]{40}$/.test(word) ? "0x" + word.slice(24) : null;
  }
  /** ABI-encoded (string, uint256) as LicensePaid's data: the licence id and the amount. Null if malformed. */
  function decodeLicensePaid(data) {
    var d = String(data || "").replace(/^0x/, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(d) || d.length < 192) return null;
    var word = function (i) { return BigInt("0x" + d.slice(i * 64, i * 64 + 64)); };
    var offset = Number(word(0)) * 2;
    var amount = word(1);
    if (offset + 64 > d.length) return null;
    var len = Number(BigInt("0x" + d.slice(offset, offset + 64)));
    if (len > 256 || offset + 64 + len * 2 > d.length) return null;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = parseInt(d.slice(offset + 64 + i * 2, offset + 66 + i * 2), 16);
    return { licenceId: new TextDecoder().decode(bytes), amount: amount };
  }

  /**
   * The payment, checked on Whitechain's public JSON-RPC: the transaction succeeded, and FaceVisa's settlement contract
   * emitted LicensePaid for this file, to the creator the receipt names, for `amount` (USDT's smallest units, =
   * micro-USD), from the brand when the licence still names it. state: "confirmed" | "mismatch" | "not-found" |
   * "unreachable". Never throws.
   */
  async function whitechainPayment(cfg, fetchFn, p) {
    var explorer = cfg.whitechainExplorer.replace(/\/$/, "");
    var out = { rail: "whitechain", source: "Whitechain's RPC", endpoint: cfg.whitechainRpc, where: "the Whitechain explorer", txId: p.ref, link: explorer + "/tx/" + p.ref, checks: [], requests: 0 };
    out.hashscan = out.link;
    // Only a transaction hash goes into a request or an explorer link.
    if (!HASH.test(String(p.ref).toLowerCase())) return Object.assign(out, { link: explorer, hashscan: explorer, state: "mismatch", checks: [{ ok: false, text: "the receipt's payment reference isn't a Whitechain transaction hash" }] });
    var call = async function (method, params) {
      out.requests++;
      var res = await fetchFn(cfg.whitechainRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }) });
      if (!res.ok) throw new Error("Whitechain's RPC answered HTTP " + res.status);
      var body = await res.json();
      if (body.error) throw new Error("Whitechain's RPC: " + (body.error.message || "error"));
      return body.result;
    };
    try {
      var r = await call("eth_getTransactionReceipt", [p.ref]);
      if (!r) return Object.assign(out, { state: "not-found" });
      var settlement = cfg.settlement.toLowerCase();
      var log = (r.logs || []).filter(function (l) { return String(l.address).toLowerCase() === settlement && l.topics && String(l.topics[0]).toLowerCase() === LICENSE_PAID; })[0];
      var paid = log ? decodeLicensePaid(log.data) : null;
      out.checks.push({ ok: r.status === "0x1", text: r.status === "0x1" ? "the transaction succeeded on Whitechain" : "the transaction failed on Whitechain" });
      out.checks.push({ ok: !!paid, text: paid ? "FaceVisa's settlement contract (" + cfg.settlement + ") emitted LicensePaid" : "no LicensePaid from FaceVisa's settlement contract (" + cfg.settlement + ")" });
      if (paid) {
        out.payee = wordAddress(log.topics[2]);
        out.payer = wordAddress(log.topics[3]);
        out.amount = Number(paid.amount);
        out.licenceId = paid.licenceId;
        out.checks.push({ ok: String(log.topics[1]).toLowerCase() === String(p.fileHash).toLowerCase(), text: "for this exact file" });
        out.checks.push({ ok: !!p.creator && out.payee === String(p.creator).toLowerCase(), text: "paid to the creator the receipt names (" + out.payee + ")" });
        out.checks.push({ ok: p.amount === null ? out.amount > 0 : out.amount === p.amount, text: out.amount / 1e6 + " USDT" + (p.amount === null ? "" : " (the licence's price: " + p.amount / 1e6 + ")") });
        if (p.licenceId) out.checks.push({ ok: paid.licenceId === p.licenceId, text: "for the licence on the receipt (" + paid.licenceId + ")" });
        // The paying wallet, as the receipt (from FaceVisa's receipt key) names it: a brand pays from its workspace's
        // own wallet. An older receipt doesn't name one: then the payer isn't checked.
        if (p.payer) out.checks.push({ ok: out.payer === String(p.payer).toLowerCase(), text: "paid from the brand's wallet the receipt names (" + out.payer + ")" });
        else out.checks.push({ ok: true, text: "this receipt doesn't name the paying wallet, so the payer (" + out.payer + ") isn't checked" });
      }
      if (r.blockNumber) {
        var b = await call("eth_getBlockByNumber", [r.blockNumber, false]);
        if (b && b.timestamp) out.consensusAt = Number(BigInt(b.timestamp)) * 1000;
      }
      out.state = out.checks.every(function (c) { return c.ok; }) ? "confirmed" : "mismatch";
      return out;
    } catch (e) {
      return Object.assign(out, { state: "unreachable", error: e && e.message ? e.message : String(e) });
    }
  }

  /** The receipt's payment, checked where its rail settles; undefined for a test payment or an unknown rail. */
  function checkPayment(cfg, fetchFn, p) {
    if (p.rail === WHITECHAIN_RAIL && cfg.whitechainRpc && cfg.settlement) return whitechainPayment(cfg, fetchFn, p);
    if (p.rail === HEDERA_RAIL && cfg.mirrorUrl) return hederaPayment(cfg, fetchFn, p);
    return Promise.resolve(undefined);
  }

  /** How a creator was verified before listing, in words. A test environment is never called World ID verification. */
  function presenceLabel(p, credential) {
    if (p === "none") return "No World ID check: listed before the check was required";
    var what = credential === "proof_of_human" ? "Proof of Human (the Orb: a unique human, once per World ID)" : "Proof of Presence (a Selfie Check: a real person, present, once per World ID)";
    if (p === "production") return what + " with World ID";
    return what + " from World ID's " + p + " (a test identity, not production World ID)";
  }

  /** How the creator approved, in words: always in FaceVisa, with how they signed in (dev, demo). */
  function identityLabel(id) {
    if (id === "world-id") return "approved by the creator in FaceVisa";
    if (id === "standin" || id === "dev") return "approved by the creator in FaceVisa, signed in with the local dev sign-in (local development: a test identity)";
    if (id === "demo") return "approved by the creator in FaceVisa, signed in with a demo identity (the public demo: a test identity)";
    if (id === "google") return "approved by the creator in FaceVisa, signed in with Google";
    return "unknown (" + id + ")";
  }

  /**
   * Verifies a file hash against Arkiv. Returns { verdict, checks, receipt, licence, ... }; never throws for a
   * negative answer, only for a network or input error.
   * verdict: "Licensed" | "Revoked" | "Expired" | "Not found" | "Not trusted" | "Inconsistent"
   */
  async function verify(options, fetchFn, nowMs) {
    var cfg = Object.assign({}, DEFAULTS, options || {});
    fetchFn = fetchFn || root.fetch.bind(root);
    var now = nowMs === undefined ? Date.now() : nowMs;
    var fileHash = String(cfg.fileHash || "").toLowerCase();
    if (!HASH.test(fileHash)) throw new Error("a SHA-256 hash is 0x followed by 64 hex digits");
    if (!ADDRESS.test(cfg.receiptAddress)) throw new Error("the receipt address isn't an address");
    if (!NAMESPACE.test(cfg.namespace)) throw new Error("the namespace is lowercase letters, digits and dashes");
    var receiptAddress = cfg.receiptAddress.toLowerCase();
    var link = function (key) { return cfg.explorerUrl.replace(/\/$/, "") + "/entity/" + key; };
    var checks = [];
    var requests = 0;
    var rateLimit = null;
    var call = async function (p) { requests++; var r = await p; rateLimit = r.rateLimit || rateLimit; return r.result; };

    // Block timing turns an entity's expiry block into a time.
    var timing = await call(rpc(cfg, "arkiv_getBlockTiming", [], fetchFn));
    var blockTime = function (block) { return (timing.current_block_time + (Number(BigInt(block)) - timing.current_block) * timing.duration) * 1000; };

    // 1. The receipt, from the published receipt address only.
    var ns = "app = str('" + cfg.namespace + "')";
    var found = await call(query(cfg, ns + " AND type = str('receipt') AND file_hash = str('" + fileHash + "') AND $owner = addr(" + receiptAddress + ")", RECEIPT_COLUMNS, fetchFn));
    var r = found.data[0];
    if (!r) {
      // Someone else may have written a receipt-shaped entity for this hash: say so, but never trust it.
      var others = await call(query(cfg, ns + " AND type = str('receipt') AND file_hash = str('" + fileHash + "')", { key: true }, fetchFn));
      var base = { fileHash: fileHash, requests: requests, rateLimit: rateLimit, checks: checks };
      if (others.data.length) {
        checks.push({ ok: false, text: others.data.length + " receipt-like entit" + (others.data.length === 1 ? "y" : "ies") + " for this file exist, but none is owned by the published receipt address: not trusted" });
        return Object.assign(base, { verdict: "Not trusted" });
      }
      return Object.assign(base, { verdict: "Not found" });
    }
    var ra = attrs(r);
    var receipt = {
      key: r.key, url: link(r.key), owner: r.owner, ownerOk: String(r.owner).toLowerCase() === receiptAddress,
      creator: ra.creator || null, licenceEndsAt: ra.licence_expires_at ? ra.licence_expires_at * 1000 : null,
      licenceKey: ra.licence_key, licenceId: ra.licence_id, provider: ra.provider, model: ra.model, jobId: ra.job_id || null, paymentRef: ra.payment_ref, expiresAt: blockTime(r.expiresAt),
      paymentRail: ra.payment_rail || null, paymentLabel: paymentLabel(ra.payment_rail, ra.payment_ref), payer: ra.payer || null,
      faceCheck: ra.face_check || null, faceScore: typeof ra.face_score === "number" ? ra.face_score / 1000 : null,
    };
    checks.push({ ok: receipt.ownerOk, text: "receipt owned by " + (receiptAddress === DEFAULTS.receiptAddress.toLowerCase() ? "the published FaceVisa receipt address " : "the receipt address set for this check (not FaceVisa's published one) ") + cfg.receiptAddress });
    // Values that go into the next queries must have their shape: a licence key, and the creator's address.
    if (!KEY.test(String(receipt.licenceKey)) || (receipt.creator !== null && !ADDRESS.test(String(receipt.creator)))) {
      checks.push({ ok: false, text: "the receipt's licence key or creator address is malformed: not trusted" });
      return { fileHash: fileHash, receipt: receipt, checks: checks, requests: requests, rateLimit: rateLimit, verdict: "Not trusted" };
    }

    // The creator's display name, from their own listing: owned by the creator the receipt names, or none.
    var creatorName = null;
    if (receipt.creator) {
      var named = await call(query(cfg, ns + " AND type = str('listing') AND $owner = addr(" + receipt.creator + ")", LISTING_COLUMNS, fetchFn));
      if (named.data[0]) creatorName = attrs(named.data[0]).display_name || null;
    }

    // 2. The creator's revocation record, first: owned by the creator the receipt names, it outlives the licence.
    var revocation = null;
    if (receipt.creator) {
      var rev = await call(query(cfg, ns + " AND type = str('revocation') AND licence_key = key(" + receipt.licenceKey + ") AND $owner = addr(" + receipt.creator + ")", REVOCATION_COLUMNS, fetchFn));
      var rv = rev.data[0];
      if (rv) {
        var rva = attrs(rv);
        revocation = { key: rv.key, url: link(rv.key), owner: rv.owner, revokedAt: rva.revoked_at * 1000 };
        checks.push({ ok: true, text: "revocation recorded by the creator's own key (" + receipt.creator + ")" });
      }
    }

    // 3. Its licence, by entity key.
    var lic = await call(query(cfg, ns + " AND type = str('licence') AND $key = key(" + receipt.licenceKey + ")", LICENCE_COLUMNS, fetchFn));
    var l = lic.data[0];
    var out = { fileHash: fileHash, receipt: receipt, revocation: revocation, creatorName: creatorName, checks: checks, requests: requests, rateLimit: rateLimit };
    // 5. The payment, where it settled (the licence, when still on Arkiv, names the brand and the price).
    var paid = async function (result) {
      var la0 = l ? attrs(l) : null;
      var pay = await checkPayment(cfg, fetchFn, { rail: receipt.paymentRail, ref: receipt.paymentRef, fileHash: fileHash, licenceId: receipt.licenceId || null, payer: receipt.payer, creator: receipt.creator || (la0 && la0.creator), brand: la0 ? la0.brand : null, amount: la0 && typeof la0.price === "number" ? la0.price : null });
      if (pay) result.payment = pay;
      return result;
    };
    if (!l && revocation) {
      checks.push({ ok: true, text: "the licence entity has since expired on Arkiv; the revocation record remains" });
      return paid(Object.assign(out, { verdict: receipt.ownerOk ? "Revoked" : "Not trusted", revokedAt: revocation.revokedAt, requests: requests, rateLimit: rateLimit }));
    }
    if (!l) {
      if (receipt.licenceEndsAt !== null && receipt.licenceEndsAt <= now) {
        checks.push({ ok: true, text: "the licence entity has expired on Arkiv (Arkiv deletes expired entities); the receipt records its end" });
        return paid(Object.assign(out, { verdict: "Expired", licenceEndedAt: receipt.licenceEndsAt, requests: requests, rateLimit: rateLimit }));
      }
      checks.push({ ok: false, text: receipt.licenceEndsAt === null ? "the licence entity isn't on Arkiv (this older receipt doesn't record the licence's end)" : "the licence entity is missing before the end its receipt records" });
      return paid(Object.assign(out, { verdict: receipt.licenceEndsAt === null ? "Expired" : "Inconsistent", requests: requests, rateLimit: rateLimit }));
    }
    var la = attrs(l);
    var owner = String(l.owner).toLowerCase();
    // The creator's own entity: owned by the creator the receipt names (older receipts: the licence's creator column).
    var creator = receipt.creator || la.creator;
    var licence = {
      key: l.key, url: link(l.key), owner: l.owner, ownerOk: owner === creator && la.creator === creator,
      status: la.status, expiresAt: blockTime(l.expiresAt), identity: la.identity, identityLabel: identityLabel(la.identity),
      licenceId: la.licence_id, usage: la.usage, kind: la.kind, durationDays: la.duration_days, price: typeof la.price === "number" ? la.price : null, brand: la.brand, creator: la.creator, approvedAt: la.approved_at ? la.approved_at * 1000 : null,
    };
    checks.push({ ok: licence.ownerOk, text: "licence owned by the creator the receipt names (" + creator + ")" + (receipt.creator ? "" : " (older receipt: checked against the licence's own creator column)") });
    var sameFile = String(la.output_hash).toLowerCase() === fileHash;
    checks.push({ ok: sameFile, text: "the licence is for this exact file" });
    out.licence = licence;
    out.requests = requests;
    out.rateLimit = rateLimit;
    if (!receipt.ownerOk || !licence.ownerOk || !sameFile) return paid(Object.assign(out, { verdict: "Not trusted" }));
    out.verdict = revocation || licence.status === "revoked" ? "Revoked" : licence.expiresAt <= now ? "Expired" : "Licensed";
    if (revocation) out.revokedAt = revocation.revokedAt;
    return paid(out);
  }

  // ---------------------------------------------------------------- where is my face used: one creator's files
  var USAGE_LIMIT = 100;

  /**
   * Where a creator's face is used: every FaceVisa receipt that names this creator address, from the published receipt
   * address only, joined with the licence and revocation entities the creator's own key owns (by licence key). Each
   * file gets the verdict verify() gives it. Reads Arkiv, and Whitechain's RPC (or Hedera's mirror node) for payments unless
   * checkPayments is false. Throws only for a network or input error.
   */
  async function creatorUsage(options, fetchFn, nowMs) {
    var cfg = Object.assign({}, DEFAULTS, options || {});
    fetchFn = fetchFn || root.fetch.bind(root);
    var now = nowMs === undefined ? Date.now() : nowMs;
    var creator = String(cfg.creator || "").trim().toLowerCase();
    if (!ADDRESS.test(creator)) throw new Error("a creator's address is 0x followed by 40 hex digits");
    if (!ADDRESS.test(cfg.receiptAddress)) throw new Error("the receipt address isn't an address");
    if (!NAMESPACE.test(cfg.namespace)) throw new Error("the namespace is lowercase letters, digits and dashes");
    var receiptAddress = cfg.receiptAddress.toLowerCase();
    var link = function (key) { return cfg.explorerUrl.replace(/\/$/, "") + "/entity/" + key; };
    var requests = 0;
    var rateLimit = null;
    var call = async function (p) { requests++; var r = await p; rateLimit = r.rateLimit || rateLimit; return r.result; };
    var timing = await call(rpc(cfg, "arkiv_getBlockTiming", [], fetchFn));
    var blockTime = function (block) { return (timing.current_block_time + (Number(BigInt(block)) - timing.current_block) * timing.duration) * 1000; };
    var ns = "app = str('" + cfg.namespace + "')";
    // Receipts are read twice: from the receipt address (the only ones trusted), and from anyone (to say how many
    // others were ignored). A flood of fake receipts can't push the real ones out of the first list.
    var answers = await Promise.all([
      call(query(cfg, ns + " AND type = str('receipt') AND creator = addr(" + creator + ") AND $owner = addr(" + receiptAddress + ")", RECEIPT_COLUMNS, fetchFn, USAGE_LIMIT)),
      call(query(cfg, ns + " AND type = str('receipt') AND creator = addr(" + creator + ")", { key: true }, fetchFn, USAGE_LIMIT)),
      call(query(cfg, ns + " AND type = str('licence') AND $owner = addr(" + creator + ")", LICENCE_COLUMNS, fetchFn, USAGE_LIMIT)),
      call(query(cfg, ns + " AND type = str('revocation') AND $owner = addr(" + creator + ")", REVOCATION_COLUMNS, fetchFn, USAGE_LIMIT)),
      call(query(cfg, ns + " AND type = str('listing') AND $owner = addr(" + creator + ")", LISTING_COLUMNS, fetchFn)),
    ]);
    var receipts = answers[0].data, anyone = answers[1].data, licences = answers[2].data, revocations = answers[3].data;
    var named = answers[4].data[0];
    var creatorName = named ? attrs(named).display_name || null : null;
    // How the creator was verified, from their own listing: Proof of Presence (and its World ID environment), or none.
    var creatorPresence = named ? attrs(named).presence || null : null;
    var creatorCredential = named ? attrs(named).credential || null : null;
    var lower = function (v) { return String(v).toLowerCase(); };

    var used = {};
    var items = receipts.map(function (r) {
      var ra = attrs(r);
      var fileHash = lower(ra.file_hash);
      var item = {
        fileHash: fileHash,
        receipt: {
          key: r.key, url: link(r.key), licenceId: ra.licence_id, provider: ra.provider, model: ra.model, jobId: ra.job_id || null,
          paymentRef: ra.payment_ref, paymentRail: ra.payment_rail || null, paymentLabel: paymentLabel(ra.payment_rail, ra.payment_ref), payer: ra.payer || null,
          faceCheck: ra.face_check || null, faceScore: typeof ra.face_score === "number" ? ra.face_score / 1000 : null,
          licenceEndsAt: ra.licence_expires_at ? ra.licence_expires_at * 1000 : null,
        },
        licence: null, revocation: null, payment: null,
      };
      if (!HASH.test(fileHash) || !KEY.test(String(ra.licence_key))) return Object.assign(item, { verdict: "Not trusted" });
      var l = licences.filter(function (x) { return lower(x.key) === lower(ra.licence_key); })[0];
      var rv = revocations.filter(function (x) { return lower(attrs(x).licence_key) === lower(ra.licence_key); })[0];
      if (rv) item.revocation = { key: rv.key, url: link(rv.key), revokedAt: attrs(rv).revoked_at * 1000 };
      if (l) {
        used[lower(l.key)] = true;
        var la = attrs(l);
        item.licence = {
          key: l.key, url: link(l.key), status: la.status, expiresAt: blockTime(l.expiresAt), usage: la.usage, kind: la.kind, durationDays: la.duration_days,
          price: typeof la.price === "number" ? la.price : null, brand: la.brand, identity: la.identity, identityLabel: identityLabel(la.identity),
          approvedAt: la.approved_at ? la.approved_at * 1000 : null,
        };
        // The same rules as verify(): the creator's own licence, for this exact file.
        var ok = lower(l.owner) === creator && la.creator === creator && lower(la.output_hash) === fileHash;
        item.verdict = !ok ? "Not trusted" : rv || la.status === "revoked" ? "Revoked" : item.licence.expiresAt <= now ? "Expired" : "Licensed";
      } else if (rv) item.verdict = "Revoked";
      else item.verdict = item.receipt.licenceEndsAt === null || item.receipt.licenceEndsAt <= now ? "Expired" : "Inconsistent";
      if (item.verdict === "Revoked" && rv) item.revokedAt = item.revocation.revokedAt;
      if (item.verdict === "Expired") item.endedAt = item.licence ? item.licence.expiresAt : item.receipt.licenceEndsAt;
      return item;
    });
    // Newest first: by approval, else by the licence's end.
    var at = function (i) { return (i.licence && i.licence.approvedAt) || i.receipt.licenceEndsAt || 0; };
    items.sort(function (a, b) { return at(b) - at(a); });

    if (cfg.checkPayments !== false) {
      await Promise.all(items.map(async function (i) {
        var pay = await checkPayment(cfg, fetchFn, { rail: i.receipt.paymentRail, ref: i.receipt.paymentRef, fileHash: i.fileHash, licenceId: i.receipt.licenceId || null, payer: i.receipt.payer, creator: creator, brand: i.licence ? i.licence.brand : null, amount: i.licence ? i.licence.price : null });
        if (pay) i.payment = pay;
      }));
    }
    var counts = {};
    items.forEach(function (i) { counts[i.verdict] = (counts[i.verdict] || 0) + 1; });
    return {
      creator: creator, creatorName: creatorName, creatorPresence: creatorPresence, creatorCredential: creatorCredential, items: items, counts: counts,
      ignored: { receipts: anyone.filter(function (x) { return lower(x.owner) !== receiptAddress; }).length, licencesWithoutReceipt: licences.filter(function (x) { return !used[lower(x.key)]; }).length },
      truncated: receipts.length >= USAGE_LIMIT, requests: requests, rateLimit: rateLimit,
    };
  }

  // ---------------------------------------------------------------- the page: the result as HTML
  // Everything read from Arkiv, Whitechain or the mirror node is public data anyone could have written: each value goes through
  // esc() (or linkTo(), which escapes both the URL and the text) before it becomes HTML.
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); };
  var when = function (ms) { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); };
  var linkTo = function (url, text) { return '<a href="' + esc(url) + '" target="_blank" rel="noreferrer" class="mono">' + esc(text) + "</a>"; };

  var HEADLINE = {
    Licensed: "Licensed",
    Revoked: "Revoked by the creator",
    Expired: "Licence expired",
    "Not found": "No FaceVisa receipt for this file on Arkiv",
    "Not trusted": "Found, but it fails the ownership checks: not trusted",
    Inconsistent: "Inconsistent: the licence entity is missing before its recorded end",
  };

  /** Which of the settings a link (or the person) changed from FaceVisa's published ones, in words. */
  function customSettings(settings) {
    var custom = [];
    if (settings.receiptAddress.toLowerCase() !== DEFAULTS.receiptAddress.toLowerCase()) custom.push("the receipt address " + settings.receiptAddress);
    if (settings.rpcUrl.replace(/\/$/, "") !== DEFAULTS.rpcUrl) custom.push("the Arkiv RPC " + settings.rpcUrl);
    return custom;
  }
  /** The query string that opens the other page with the same namespace and settings (published ones left out). */
  function settingsQuery(settings) {
    var q = "&ns=" + encodeURIComponent(settings.namespace || DEFAULTS.namespace);
    if (settings.receiptAddress.toLowerCase() !== DEFAULTS.receiptAddress.toLowerCase()) q += "&receipt=" + encodeURIComponent(settings.receiptAddress);
    if (settings.rpcUrl.replace(/\/$/, "") !== DEFAULTS.rpcUrl) q += "&rpc=" + encodeURIComponent(settings.rpcUrl);
    return q;
  }

  /** The result of verify() as the page's HTML. settings: { receiptAddress, rpcUrl } as the person (or a link) set them. */
  function render(r, settings) {
    // A link can set the receipt address and the RPC. With any but FaceVisa's published ones, the page never shows a
    // verdict as FaceVisa's (no green "Licensed"): what those settings say is a detail, with a way back.
    var custom = customSettings(settings);
    var html;
    if (custom.length) {
      html = '<p class="verdict Custom">Not verified by FaceVisa (custom settings)</p>';
      html += "<p>This check trusts " + esc(custom.join(" and ")) + ", not FaceVisa's published " + (custom.length === 2 ? "ones" : "one") + ". With these settings the answer is: <b>" + esc(HEADLINE[r.verdict] || r.verdict) + "</b>. Whoever chose them (perhaps the link you followed) decides what that means.</p>";
      html += '<button type="button" id="use-defaults">Use FaceVisa\'s published settings</button>';
    } else html = '<p class="verdict ' + r.verdict.replace(/ /g, "-") + '">' + esc(HEADLINE[r.verdict] || r.verdict) + "</p>";
    if (r.verdict === "Revoked" && r.revokedAt) html += "<p><b>Revoked on " + esc(when(r.revokedAt)) + "</b> by the creator (their revocation record, owned by their key).</p>";
    if (r.verdict === "Expired" && r.licenceEndedAt) html += "<p><b>Licence expired on " + esc(when(r.licenceEndedAt)) + "</b> (the end recorded on the receipt; the licence entity is gone from Arkiv).</p>";
    if (r.verdict === "Licensed" && r.licence) html += "<p>In force until " + esc(when(r.licence.expiresAt)) + ".</p>";
    if (r.checks.length) html += "<ul>" + r.checks.map(function (c) { return "<li>" + (c.ok ? "✓ " : "✗ ") + esc(c.text) + "</li>"; }).join("") + "</ul>";
    html += "<dl>";
    html += "<dt>File SHA-256</dt><dd class=\"mono\">" + esc(r.fileHash) + "</dd>";
    if (r.receipt) {
      html += "<dt>Receipt</dt><dd>" + linkTo(r.receipt.url, r.receipt.key) + "</dd>";
      html += "<dt>Receipt owner</dt><dd class=\"mono\">" + esc(r.receipt.owner) + "</dd>";
      // A 0G file: its request on 0G's record (whether 0G verified a TEE signature isn't on Arkiv, so never claimed here).
      var made = r.receipt.provider === "test" ? "a TEST RENDER (no AI model)" : esc(r.receipt.model) + " (" + esc(r.receipt.provider) + ")" + (r.receipt.jobId ? (String(r.receipt.provider).split("+").indexOf("0g") >= 0 ? ", 0G request record " : ", request ") + esc(r.receipt.jobId) : "");
      if (r.receipt.faceCheck) made += " · face check " + (r.receipt.faceCheck === "passed" ? "passed" + (r.receipt.faceScore !== null ? " (" + r.receipt.faceScore.toFixed(3) + ")" : "") : "not run");
      html += "<dt>Made by</dt><dd>" + made + "</dd>";
      html += "<dt>Payment</dt><dd>" + esc(r.receipt.paymentLabel) + " " + (r.payment ? linkTo(r.payment.link, r.receipt.paymentRef) : "<span class=\"mono muted\">" + esc(r.receipt.paymentRef) + "</span>") + "</dd>";
      if (r.payment) html += "<dt>" + (r.payment.rail === "whitechain" ? "On Whitechain" : "On Hedera") + "</dt><dd>" + paymentHtml(r.payment) + "</dd>";
      if (r.receipt.licenceEndsAt) html += "<dt>Licence ends (receipt)</dt><dd>" + esc(when(r.receipt.licenceEndsAt)) + "</dd>";
    }
    if (r.revocation) html += "<dt>Revocation record</dt><dd>" + linkTo(r.revocation.url, r.revocation.key) + "</dd>";
    if (r.licence) {
      html += "<dt>Licence</dt><dd>" + linkTo(r.licence.url, r.licence.key) + " (" + esc(r.licence.licenceId) + ")</dd>";
      html += "<dt>Status</dt><dd>" + esc(r.licence.status) + "</dd>";
      html += "<dt>Entity expires</dt><dd>" + esc(when(r.licence.expiresAt)) + "</dd>";
      html += "<dt>Identity</dt><dd>" + esc(r.licence.identityLabel) + " <span class=\"muted\">(identity = " + esc(r.licence.identity) + ")</span></dd>";
      html += "<dt>Usage</dt><dd>" + esc(r.licence.kind) + " for " + esc(r.licence.usage) + ", " + esc(r.licence.durationDays) + " days</dd>";
      html += "<dt>Creator (owner)</dt><dd>" + (r.creatorName ? "<b>" + esc(r.creatorName) + "</b> <span class=\"muted\">(their listing on Arkiv)</span> · " : "") + "<span class=\"mono\">" + esc(r.licence.owner) + "</span>" + (ADDRESS.test(String(r.licence.owner)) ? ' · <a href="creator.html?creator=' + esc(r.licence.owner) + esc(settingsQuery(settings)) + '">where else their face is used</a>' : "") + "</dd>";
      html += "<dt>Brand</dt><dd class=\"mono\">" + esc(r.licence.brand) + "</dd>";
    }
    html += "</dl>";
    html += '<p class="muted">' + r.requests + " requests to " + esc(settings.rpcUrl) + (r.rateLimit ? " · rate limit now: <code>" + esc(r.rateLimit) + "</code>" : "") + "</p>";
    return html;
  }
  /** The chain's answer about the payment, or why there isn't one (then the explorer is the place to look). */
  function paymentHtml(p) {
    var head = {
      confirmed: "<b>Confirmed by " + esc(p.source) + "</b>" + (p.consensusAt ? " (" + (p.rail === "whitechain" ? "block time " : "consensus ") + esc(when(p.consensusAt)) + ")" : ""),
      mismatch: '<b class="error">' + esc(p.source) + " doesn't match the receipt</b>",
      "not-found": "Not on " + esc(p.source) + " (yet): check it on " + linkTo(p.link, p.where),
      unreachable: esc(p.source) + " couldn't be reached from this browser (" + esc(p.error) + "): check it on " + linkTo(p.link, p.where),
    }[p.state];
    var list = p.checks.length ? "<ul>" + p.checks.map(function (c) { return "<li>" + (c.ok ? "✓ " : "✗ ") + esc(c.text) + "</li>"; }).join("") + "</ul>" : "";
    return head + list + '<span class="muted">' + p.requests + " requests to " + esc(p.endpoint) + "</span>";
  }

  var SHORT = { Licensed: "Licensed", Revoked: "Revoked", Expired: "Expired", "Not trusted": "Not trusted", Inconsistent: "Inconsistent" };
  /** A payment's on-chain answer, in one line. */
  function paymentShort(p) {
    if (!p) return "";
    if (p.state === "confirmed") return " · ✓ confirmed by " + esc(p.source) + (p.payer ? " (" + esc(p.payer) + " → " + esc(p.payee) + ")" : "");
    if (p.state === "mismatch") return ' · <span class="error">✗ ' + esc(p.source) + " doesn't match: " + esc(p.checks.filter(function (c) { return !c.ok; }).map(function (c) { return c.text; }).join("; ")) + "</span>";
    if (p.state === "not-found") return " · not on " + esc(p.source) + " (yet)";
    return " · " + esc(p.source) + " couldn't be reached (" + esc(p.error) + ")";
  }

  /** The result of creatorUsage() as the page's HTML. settings: { namespace, receiptAddress, rpcUrl }. */
  function renderCreator(r, settings) {
    var custom = customSettings(settings);
    var who = r.creatorName ? "<b>" + esc(r.creatorName) + "</b> (" + '<span class="mono">' + esc(r.creator) + "</span>)" : '<span class="mono">' + esc(r.creator) + "</span>";
    var summary = ["Licensed", "Revoked", "Expired", "Not trusted", "Inconsistent"].filter(function (v) { return r.counts[v]; }).map(function (v) { return r.counts[v] + " " + SHORT[v].toLowerCase(); }).join(" · ");
    var html;
    if (custom.length) {
      html = '<p class="verdict Custom">Not verified by FaceVisa (custom settings)</p>';
      html += "<p>This list trusts " + esc(custom.join(" and ")) + ", not FaceVisa's published " + (custom.length === 2 ? "ones" : "one") + ". Whoever chose them (perhaps the link you followed) decides what it means.</p>";
      html += '<button type="button" id="use-defaults">Use FaceVisa\'s published settings</button>';
    } else html = '<p class="verdict">' + (r.items.length ? r.items.length + (r.items.length === 1 ? " file" : " files") : "No files") + "</p>";
    html += "<p>The face of " + who + (r.items.length ? ": " + esc(summary) + "." : ": no FaceVisa receipt names this creator in this namespace.") + (r.creatorName ? ' <span class="muted">(the name is from their own listing on Arkiv)</span>' : "") + "</p>";
    if (r.creatorPresence) html += "<p>" + esc(presenceLabel(r.creatorPresence, r.creatorCredential)) + ' <span class="muted">(presence = ' + esc(r.creatorPresence) + (r.creatorCredential ? ", credential = " + esc(r.creatorCredential) : "") + ", from their listing on Arkiv)</span></p>";
    r.items.forEach(function (i) {
      var l = i.licence;
      var head = SHORT[i.verdict] + (i.verdict === "Revoked" && i.revokedAt ? " on " + when(i.revokedAt) : i.verdict === "Expired" && i.endedAt ? " on " + when(i.endedAt) : i.verdict === "Licensed" && l ? " until " + when(l.expiresAt) : "");
      html += '<article class="item"><p><span class="pill ' + i.verdict.replace(/ /g, "-") + '">' + esc(head) + "</span> " + (l ? "<b>" + esc(l.kind) + " for " + esc(l.usage) + ", " + esc(l.durationDays) + " days</b>" : '<b>licence ' + esc(i.receipt.licenceId) + '</b> <span class="muted">(its entity is gone from Arkiv)</span>') + "</p><dl>";
      html += '<dt>File</dt><dd><span class="mono">' + esc(i.fileHash) + '</span> · <a href="index.html?hash=' + esc(i.fileHash) + esc(settingsQuery(settings)) + '">verify this file</a></dd>';
      if (l) {
        html += '<dt>Brand</dt><dd class="mono">' + esc(l.brand) + "</dd>";
        if (l.approvedAt) html += "<dt>Approved</dt><dd>" + esc(when(l.approvedAt)) + ", " + esc(l.identityLabel) + "</dd>";
      }
      html += "<dt>Made by</dt><dd>" + (i.receipt.provider === "test" ? "a TEST RENDER (no AI model)" : esc(i.receipt.model) + " (" + esc(i.receipt.provider) + ")") + (i.receipt.faceCheck === "passed" && i.receipt.faceScore !== null ? " · face check passed (" + i.receipt.faceScore.toFixed(3) + ")" : "") + "</dd>";
      html += "<dt>Payment</dt><dd>" + esc(i.receipt.paymentLabel) + " " + (i.payment ? linkTo(i.payment.link, i.receipt.paymentRef) : '<span class="mono muted">' + esc(i.receipt.paymentRef) + "</span>") + paymentShort(i.payment) + "</dd>";
      html += "<dt>On Arkiv</dt><dd>receipt " + linkTo(i.receipt.url, i.receipt.key.slice(0, 10) + "…") + (l ? " · licence " + linkTo(l.url, l.key.slice(0, 10) + "…") : "") + (i.revocation ? " · revocation " + linkTo(i.revocation.url, i.revocation.key.slice(0, 10) + "…") : "") + "</dd>";
      html += "</dl></article>";
    });
    var notes = [];
    if (r.truncated) notes.push("showing the first " + USAGE_LIMIT + " receipts");
    if (r.ignored.receipts) notes.push(r.ignored.receipts + " receipt-like entit" + (r.ignored.receipts === 1 ? "y" : "ies") + " naming this creator from other addresses ignored (not FaceVisa's)");
    if (r.ignored.licencesWithoutReceipt) notes.push(r.ignored.licencesWithoutReceipt + " licence entit" + (r.ignored.licencesWithoutReceipt === 1 ? "y" : "ies") + " owned by this creator with no FaceVisa receipt (not counted)");
    html += '<p class="muted">' + (notes.length ? esc(notes.join("; ")) + ". " : "") + r.requests + " requests to " + esc(settings.rpcUrl) + (r.rateLimit ? " · rate limit now: <code>" + esc(r.rateLimit) + "</code>" : "") + "</p>";
    return html;
  }

  // LikenessVerifier: a legacy alias.
  root.FaceVisaVerifier = root.LikenessVerifier = { DEFAULTS: DEFAULTS, verify: verify, sha256Hex: sha256Hex, identityLabel: identityLabel, presenceLabel: presenceLabel, paymentLabel: paymentLabel, hederaPayment: hederaPayment, whitechainPayment: whitechainPayment, mirrorTxId: mirrorTxId, render: render, esc: esc, creatorUsage: creatorUsage, renderCreator: renderCreator };
})(typeof globalThis !== "undefined" ? globalThis : this);
