/**
 * The server's state: accounts and sessions (World ID), creator profiles, rendered files, and FaceVisa's own flow
 * (facevisa/: listings, the brand agent, the render pipeline, the consent checkpoints). One SQLite file per mode,
 * on disk (local: accounts/local/accounts.sqlite, git-ignored; `pnpm reset-local` wipes it).
 */
import { Swarm, swarmConfigFromEnv, type SwarmConfig } from "../swarm/swarm.js";
import type { Hex } from "viem";
import { formatEther } from "viem";
import { assertVertexAllowed } from "../ai/vertex.js";
import { createCore, devConsent, type Core, type CoreOptions } from "../facevisa/core.js";
import { Accounts } from "./accounts.js";
import { Approvals } from "./approval.js";
import { localDevAllowed } from "./devmode.js";
import { Onboarding } from "./onboarding.js";
import type { StandIn } from "./standin.js";
import { RenderStore } from "./store.js";
import { worldIdFromEnv, type WorldId } from "./worldid.js";
import { parseFace, parseTopics, youtubeConfigFromEnv, YouTubeLink, type ChannelMatcher, type YouTubeConfig } from "./youtube.js";
import { channelScores, faceModelsPresent } from "../facevisa/face.js";
import { consentThreshold } from "../face/check.js";
import { arkivConfigFromEnv, DEV_NAMESPACE, PUBLIC_NAMESPACE, RabdiClient, REAL_NAMESPACE, scrub, type ArkivClient, type ArkivConfig } from "../arkiv/chain.js";
import { ArkivSync } from "../arkiv/outbox.js";
import { ArkivReads } from "../arkiv/reads.js";
import { keystoreFromEnv, type Keystore } from "./keystore.js";
import { Demo, demoConfigFromEnv, isPublicAccount } from "./demo.js";
import { googleFromEnv } from "./google.js";
import { WHITECHAIN_RAIL, WhitechainRail, whitechainConfigFromEnv, type WhitechainClient, type WhitechainConfig } from "../whitechain/whitechain.js";
import { Presence, presenceConfigFromEnv, type PresenceConfig } from "./presence.js";
import { consentMethod } from "./facevisaRoutes.js";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { Hedera, hederaConfigFromEnv, type HederaConfig } from "../hedera/hedera.js";
import { X402Ads, X402_RAIL } from "../hedera/x402.js";
import { X402Payer } from "../hedera/payer.js";
import { AuditLog, type TopicWriter } from "../hedera/audit.js";

/** local: a developer's machine (local-development switches allowed); testnet/mainnet: deployed (never). */
export type Mode = "local" | "testnet" | "mainnet";

export interface Runtime {
  mode: Mode;
  root: string;
  publicUrl: string;
  store: RenderStore;
  accounts: Accounts;
  onboarding: Onboarding;
  /**
   * The sign-in issuer (OIDC): locally the dev sign-in (the stand-in); World ID only with WORLDID_SIGNIN=1 (off by
   * default: World ID appears only as the IDKit check before listing). The public demo signs in with `demo`.
   */
  worldId: WorldId | undefined;
  /** FaceVisa's own flow: listings, the brand agent, consent, the render pipeline. */
  core: Core;
  /** Sign in with Google (GOOGLE_SIGNIN=1). On the public demo it replaces the demo identities. */
  google?: WorldId;
  /** How releases are paid: "whitechain" (USDT, gasless for the brand), "hedera" (PAYMENTS=hedera), or "dev" (no money). */
  payments: "whitechain" | "hedera" | "dev";
  /** Whitechain payments: the release step's rail, the relayer and the demo's USDT top-ups. */
  whitechain?: WhitechainRail;
  /** Released ads on Swarm (SWARM_BEE_URL, SWARM_BATCH_ID): uploaded once each, the reference on the Arkiv receipt. */
  swarm?: Swarm;
  /** In-app approvals: the creator approves the exact ad, the brand approves a spend over its limit. */
  approvals: Approvals;
  /** The local dev sign-in (an OIDC stand-in), served at /api/dev/worldid (local development only). */
  standin?: StandIn;
  /** The public demo's identity provider, served at /api/demo/id (FACEVISA_PUBLIC_DEMO=1), alongside real World ID. */
  demo?: StandIn;
  /** The public demo's limits, top-ups and 48-hour retention (with `demo`). */
  demoState?: Demo;
  /** YouTube channel linking (optional for creators), when GOOGLE_OAUTH_* is configured. */
  youtube?: YouTubeLink;
  /** The Arkiv mirror of public state (listings, requests, licences, receipts), when ARKIV_ENABLED=1. */
  arkiv?: ArkivSync;
  /** Reads from Arkiv for the shortlist, the creator's inbox and Verify. */
  arkivReads?: ArkivReads;
  keystore?: Keystore;
  /** Proof of Presence (IDKit Selfie Check) before listing, when WORLD_APP_ID/WORLD_RP_ID/WORLD_RP_SIGNING_KEY_FILE are set. */
  presence?: Presence;
  /** Hedera testnet (B4), with PAYMENTS=hedera: accounts, the x402 ad endpoint, and the brand agent's x402 client. */
  hedera?: Hedera;
  /** Tests: the fake mirror node Verify asks. */
  mirrorFetch?: typeof fetch;
  x402?: X402Ads;
  payer?: X402Payer;
  /** The brand agent's audit log on an HCS topic. */
  audit?: AuditLog;
  stop(): void;
}

export interface RuntimeOptions extends CoreOptions {
  mode: Mode;
  root: string;
  publicUrl: string;
  worldId?: WorldId;
  /** The local World ID stand-in (local development only); its client is then the worldId. */
  standin?: StandIn;
  /** The public demo's identity provider: a second issuer next to World ID, only in the public namespace. */
  demo?: StandIn;
  /** Sign in with Google (tests pass a client with a fake Google); otherwise GOOGLE_SIGNIN=1 from the environment. */
  google?: WorldId;
  /** Whitechain payments (tests pass a fake chain client); otherwise PAYMENTS=whitechain with WHITECHAIN_SETTLEMENT. */
  whitechain?: { config: WhitechainConfig; client?: WhitechainClient; receiptMs?: number; pollMs?: number; keystore?: Keystore };
  /** YouTube linking (tests pass a fake Google and matcher); otherwise from GOOGLE_OAUTH_* and the local face matcher. */
  youtube?: YouTubeConfig;
  channelMatcher?: ChannelMatcher;
  /** Arkiv (tests pass a fake client, a keystore and a config); otherwise from ARKIV_* and the keystore. */
  arkiv?: { client: ArkivClient; keystore: Keystore; config: ArkivConfig; autoRun?: boolean };
  /** Swarm (tests pass a config and a fake Bee); otherwise SWARM_BEE_URL with SWARM_BATCH_ID. */
  swarm?: { config: SwarmConfig; fetch?: typeof fetch; autoRun?: boolean };
  /** Proof of Presence (tests pass a config and a fake World verify endpoint); otherwise from WORLD_* settings. */
  presence?: { config: PresenceConfig; fetch?: typeof fetch };
  /** Hedera x402 (tests pass a config, a fake facilitator, a keystore and a fake mirror node); otherwise PAYMENTS=hedera. */
  hedera?: { config: HederaConfig; facilitator: FacilitatorClient; keystore: Keystore; fetch?: typeof fetch; baseUrl?: string; pollMs?: number; writer?: TopicWriter };
}

export async function startRuntime(opts: RuntimeOptions): Promise<Runtime> {
  // Never Vertex in another project's GCP: refuse to start before anything else.
  assertVertexAllowed();
  // World ID from the environment unless given (tests pass their own); a private_key_jwt key is read once here.
  // World ID sign-in only with WORLDID_SIGNIN=1 (the OIDC code stays, off by default).
  const worldId = opts.standin?.client ?? opts.worldId ?? (process.env.WORLDID_SIGNIN === "1" ? await worldIdFromEnv() : undefined);
  // Sign in with Google (GOOGLE_SIGNIN=1), next to the dev sign-in locally, instead of the demo identities in public.
  const google = opts.google ?? googleFromEnv();
  const dir = `${opts.root}accounts/${opts.mode}`;
  const accounts = new Accounts(`${dir}/accounts.sqlite`);
  const onboarding = new Onboarding({ accounts, photosDir: `${dir}/photos` });
  const store = new RenderStore(`${opts.root}renders`);
  const arkivConfig = opts.arkiv?.config ?? arkivConfigFromEnv();
  // The public demo's identities are test identities: only ever in their own namespace, and never with the stand-in.
  if (opts.demo && arkivConfig?.prefix !== PUBLIC_NAMESPACE) throw new Error(`FACEVISA_PUBLIC_DEMO=1 needs ARKIV_ENABLED=1 and ARKIV_SCHEMA_PREFIX=${PUBLIC_NAMESPACE} (never ${REAL_NAMESPACE})`);
  if (opts.demo && opts.standin) throw new Error("the public demo and the local dev sign-in never run together");
  const dev = devLifetimes(arkivConfig?.prefix, localDevAllowed(opts.mode));
  const core = createCore({ accounts, onboarding, store, ...opts, ...(dev.licenceMs ? { licenceMs: dev.licenceMs } : {}) });
  // Consent: in-app approvals by the signed-in creator (the exact ad) and brand (a spend over its limit). DevConsent
  // (approved at once) only in local development with no sign-in at all, as before (the tests that drive the pipeline).
  const approvals = new Approvals({ data: core.data, accounts, agent: core.agent });
  if (worldId || google || opts.demo || !localDevAllowed(opts.mode)) core.useConsent(approvals);
  else core.useConsent(devConsent(core));
  const ytConfig = opts.youtube ?? youtubeConfigFromEnv(opts.publicUrl);
  const youtube = ytConfig
    ? new YouTubeLink(ytConfig, {
        accounts,
        threshold: consentThreshold,
        match:
          opts.channelMatcher ??
          (async (uid, images) => {
            const row = accounts.creator(uid);
            return row && faceModelsPresent() ? channelScores(onboarding.captureFrames(row), images) : undefined;
          }),
      })
    : undefined;
  core.agent.d.creatorInfo = (uid) => {
    const row = accounts.creator(uid);
    if (!row?.youtubeChannelId) return undefined;
    return { title: row.youtubeTitle ?? row.youtubeChannelId, subscribers: row.youtubeSubscribers, topics: parseTopics(row), faceMatch: parseFace(row)?.badge ?? false };
  };
  const presenceConfig = opts.presence?.config ?? presenceConfigFromEnv(opts.root, localDevAllowed(opts.mode));
  const presence = presenceConfig ? new Presence(accounts.db, presenceConfig, opts.presence?.fetch ? { fetch: opts.presence.fetch } : {}) : undefined;
  // A person completes an action once, ever: the real action is never spent outside the real namespace.
  if (presenceConfig?.action === DEMO_ACTION && arkivConfig?.prefix !== REAL_NAMESPACE) throw new Error(`WORLD_IDKIT_ACTION=${DEMO_ACTION} is the real listing's one-time action: use it only with ARKIV_SCHEMA_PREFIX=${REAL_NAMESPACE} (in development: list-likeness-dev, or presence-test)`);
  // Sandbox and staging proofs are test identities: only ever on the dev database, never the demo's or the real one.
  // ... or on the public demo, where every proof is labelled with its environment (never as World ID production).
  const testProofsAllowed = arkivConfig?.prefix === DEV_NAMESPACE || (!!opts.demo && arkivConfig?.prefix === PUBLIC_NAMESPACE);
  if (presenceConfig && presenceConfig.environment !== "production" && !testProofsAllowed) throw new Error(`WORLD_IDKIT_ENVIRONMENT=${presenceConfig.environment} gives test proofs: use it only on the dev database (ARKIV_SCHEMA_PREFIX=${DEV_NAMESPACE}) or the public demo (${PUBLIC_NAMESPACE})`);
  // Proof of Presence on: the shortlist knows who is verified, and in which environment.
  if (presence)
    core.agent.d.presenceOf = (uid) => {
      const s = presence.status(uid);
      return s.verified ? { environment: presence.config.environment, credential: s.credential ?? "selfie" } : null;
    };
  // Payments: Whitechain by default (PAYMENTS=whitechain, with WHITECHAIN_SETTLEMENT); Hedera x402 with PAYMENTS=hedera
  // (its code and tests stay); DevPayment (no money moves) when neither is configured.
  const paymentsWanted = opts.hedera ? "hedera" : opts.whitechain ? "whitechain" : process.env.PAYMENTS || "whitechain";
  if (!["whitechain", "hedera", "dev"].includes(paymentsWanted)) throw new Error("PAYMENTS: whitechain, hedera or dev");
  const x402Wanted = paymentsWanted === "hedera";
  const wcConfig = paymentsWanted === "whitechain" ? (opts.whitechain?.config ?? whitechainConfigFromEnv(opts.root)) : undefined;
  // One keystore for Arkiv and Hedera: the same custodial key per account on both.
  const swarmConfig = opts.swarm?.config ?? swarmConfigFromEnv();
  const keystore = opts.arkiv?.keystore ?? opts.hedera?.keystore ?? opts.whitechain?.keystore ?? (arkivConfig || x402Wanted || wcConfig || swarmConfig ? keystoreFromEnv(opts.root, opts.mode) : undefined);
  // Swarm before Arkiv: a receipt waits for its file's upload, and carries the reference.
  let arkivRef: ReturnType<typeof startArkiv>;
  const swarm =
    swarmConfig && keystore
      ? new Swarm({
          db: accounts.db,
          keystore,
          config: swarmConfig,
          file: (hash) => store.read(hash as Hex),
          parties: (hash) => {
            const r = core.data.receipt(hash);
            const l = r && core.data.licence(r.licenceId);
            return l ? { brand: l.brand, creator: l.creator } : undefined;
          },
          onUploaded: (hash) => arkivRef?.sync.enqueue("receipt", hash.toLowerCase()),
          ...(opts.swarm?.fetch ? { fetch: opts.swarm.fetch } : {}),
          ...(opts.swarm?.autoRun !== undefined ? { autoRun: opts.swarm.autoRun } : {}),
        })
      : undefined;
  const arkiv = startArkiv(opts, accounts, core, presence, arkivConfig, dev.listingMs, keystore, swarm);
  arkivRef = arkiv;
  if (swarm) {
    // Each newly released file is queued for Swarm before Arkiv hears of its receipt (only releases from now on: ads
    // released before this consent mentioned Swarm are left where they are).
    const toArkiv = core.data.onChange;
    core.data.onChange = (c) => {
      if (c.kind === "receipt") swarm.enqueue(c.hash);
      toArkiv?.(c);
    };
    void swarm.refresh().catch(() => undefined);
    setInterval(() => void swarm.refresh().catch(() => undefined), 3600_000).unref();
    if (!opts.swarm) console.log(`[swarm] on: Bee ${swarmConfig!.beeUrl}, batch ${swarmConfig!.batchId.slice(0, 8)}…, gateway ${swarmConfig!.gateway}; showcase creators: ${swarmConfig!.showcase.size}`);
  }
  // The public demo: per-visitor limits, testnet USDC top-ups, and the 48-hour retention rule (hourly, and now).
  const demoState = opts.demo ? new Demo(accounts.db, demoConfigFromEnv(), process.env.SESSION_SECRET || "demo") : undefined;
  const retention = demoState ? () => demoState.cleanup({ accounts, data: core.data, store, photosDir: `${dir}/photos` }) : undefined;
  retention?.();
  const retentionTimer = retention ? setInterval(retention, 3600_000) : undefined;
  retentionTimer?.unref();
  const x402 = x402Wanted ? startX402(opts, accounts, core, store, keystore, arkivConfig?.prefix ?? "no-arkiv", demoState) : undefined;
  const whitechain = wcConfig ? startWhitechain(opts, accounts, core, keystore, wcConfig, demoState) : undefined;
  // After a restart: nothing left mid-generation or mid-payment, nothing paid twice (Pipeline.recover).
  const recovered = core.pipeline.recover({
    reconcile: (p) => {
      if (whitechain && p.rail === WHITECHAIN_RAIL) {
        void whitechain.reconcile(p, { finish: (pay, ref) => void core.pipeline.finish(pay.actionId, pay, ref, WHITECHAIN_RAIL), abandon: (pay, why) => core.pipeline.abandon(pay.actionId, pay, why) }).catch((e) => console.error(`[recover] ${p.id}: ${(e as Error).message.split("\n")[0]}`));
        return true;
      }
      if (!x402 || p.rail !== X402_RAIL) return false;
      void x402.ads.reconcile(p).catch((e) => console.error(`[recover] ${p.id}: ${(e as Error).message.split("\n")[0]}`));
      return true;
    },
  });
  if (recovered.failed + recovered.released + recovered.watching + recovered.reverted) console.log(`[recover] after the restart: ${recovered.released} released (already paid), ${recovered.watching} payments being confirmed, ${recovered.reverted} payments never sent (approved again), ${recovered.failed} generations interrupted (failed)`);
  core.agent.resume();
  return {
    mode: opts.mode,
    root: opts.root,
    publicUrl: opts.publicUrl,
    store,
    ...(swarm ? { swarm } : {}),
    accounts,
    onboarding,
    worldId,
    core,
    approvals,
    ...(google ? { google } : {}),
    payments: whitechain ? "whitechain" : x402 ? "hedera" : "dev",
    ...(whitechain ? { whitechain } : {}),
    standin: opts.standin,
    ...(opts.demo ? { demo: opts.demo } : {}),
    ...(demoState ? { demoState } : {}),
    youtube,
    ...(arkiv ? { arkiv: arkiv.sync, arkivReads: arkiv.reads, keystore: arkiv.keystore } : {}),
    ...(presence ? { presence } : {}),
    ...(x402 ? { hedera: x402.hedera, x402: x402.ads, payer: x402.payer, audit: x402.audit } : {}),
    ...(opts.hedera?.fetch ? { mirrorFetch: opts.hedera.fetch } : {}),
    stop: () => {
      if (retentionTimer) clearInterval(retentionTimer);
      core.stop();
      arkiv?.stop();
      x402?.audit.stop();
    },
  };
}

/** The real namespace's Proof of Presence action (World ID lets each person complete an action once). */
export const DEMO_ACTION = "list-likeness";

/**
 * Development only, to watch Arkiv's lifecycle live in minutes: every licence lasts ARKIV_DEV_LICENCE_MINUTES (its
 * entity expires with it), and a listing entity lives ARKIV_DEV_LISTING_MINUTES, renewed at half by a 30 s sweep.
 * Refused outside facevisa-dev and outside local development.
 */
export function devLifetimes(prefix: string | undefined, localDev: boolean, env = process.env): { licenceMs?: number; listingMs?: number } {
  const minutes = (name: string) => {
    const v = env[name];
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 2 || n > 24 * 60) throw new Error(`${name}: minutes, 2 to 1440`);
    if (prefix !== DEV_NAMESPACE || !localDev) throw new Error(`${name} is for development only: ARKIV_SCHEMA_PREFIX=${DEV_NAMESPACE} with FACEVISA_LOCAL_DEV=1`);
    return n * 60_000;
  };
  const licenceMs = minutes("ARKIV_DEV_LICENCE_MINUTES");
  const listingMs = minutes("ARKIV_DEV_LISTING_MINUTES");
  return { ...(licenceMs ? { licenceMs } : {}), ...(listingMs ? { listingMs } : {}) };
}

/**
 * One database mirrors to one namespace: the first start with Arkiv on binds it, and another prefix is refused until
 * `pnpm reset-local`, so test data can't be backfilled into another namespace.
 * - facevisa-v1 (real data): a fresh database and real World ID consent, no stand-in, no DevConsent; the outbox
 *   adds a last line there (realOnly): a record with a test identity is never written.
 */
export function guardNamespace(prefix: string, accounts: Accounts, core: Core, opts: Pick<RuntimeOptions, "standin">) {
  const db = accounts.db;
  const bound = (db.prepare("select value from meta where key = 'arkiv_namespace'").get() as { value: string } | undefined)?.value;
  if (bound && bound !== prefix) throw new Error(`this database already mirrors to the Arkiv namespace ${bound}; to use ${prefix}, stop the backend and run \`pnpm reset-local\` first`);
  const accountsSoFar = Number((db.prepare("select count(*) as n from accounts").get() as { n: number }).n);
  if (prefix === REAL_NAMESPACE) {
    if (opts.standin || process.env.WORLDID_STANDIN === "1") throw new Error(`${REAL_NAMESPACE} is for real data: start without the dev sign-in (WORLDID_STANDIN)`);
    if (core.consent?.name !== "in-app") throw new Error(`${REAL_NAMESPACE} is for real data: it needs in-app approvals, not DevConsent`);
  }
  if (prefix === REAL_NAMESPACE && !bound && accountsSoFar > 0) throw new Error(`${prefix} needs a fresh database: stop the backend, run \`pnpm reset-local\`, then start again`);
  if (!bound) {
    db.prepare("insert into meta (key, value) values ('arkiv_namespace', ?)").run(prefix);
    // From when this namespace's records start: stats count only what happened in it.
    db.prepare("insert into meta (key, value) values ('arkiv_namespace_since', ?) on conflict(key) do nothing").run(String(Date.now()));
  }
}

/**
 * Arkiv, when ARKIV_ENABLED=1: the outbox worker, a backfill of whatever isn't mirrored yet, and an hourly sweep
 * (listings to extend). It needs the keystore (FACEVISA_KEYSTORE_PASSWORD_FILE). An unreachable RPC is logged and
 * never stops the app: writes wait in the outbox.
 */
function startArkiv(opts: RuntimeOptions, accounts: Accounts, core: Core, presence: Presence | undefined, config: ArkivConfig | undefined, listingMs: number | undefined, keystore: Keystore | undefined, swarm?: Swarm) {
  if (!config) return undefined;
  if (!keystore) throw new Error("ARKIV_ENABLED=1 needs FACEVISA_KEYSTORE_PASSWORD_FILE (the keystore holds the keys that write to Arkiv)");
  guardNamespace(config.prefix, accounts, core, opts);
  // The real namespace lists only creators who passed Proof of Presence in production.
  if (config.prefix === REAL_NAMESPACE && (presence?.config.environment !== "production" || presence.config.action !== DEMO_ACTION)) throw new Error(`${REAL_NAMESPACE} is for real data: it needs Proof of Presence (WORLD_APP_ID, WORLD_RP_ID, WORLD_RP_SIGNING_KEY_FILE) in production, with WORLD_IDKIT_ACTION=${DEMO_ACTION}`);
  const client = opts.arkiv?.client ?? new RabdiClient(config);
  const sync = new ArkivSync({ db: accounts.db, data: core.data, accounts, keystore, client, config, identityOf: consentMethod, realOnly: config.prefix === REAL_NAMESPACE, ...(presence ? { presenceOf: (uid: string) => (presence.status(uid).verified ? presence.config.environment : "none"), credentialOf: (uid: string) => presence.status(uid).credential } : {}), ...(listingMs ? { listingLifetimeMs: listingMs } : {}), ...(swarm ? { swarmOf: (hash: string) => swarm.status(hash) } : {}), autoRun: opts.arkiv?.autoRun ?? true });
  if (!opts.arkiv) {
    const funder = keystore.platformKey("funder").address;
    const receipt = keystore.platformKey("receipt").address;
    void Promise.all([client.chainId(), client.balance(funder)])
      .then(([id, bal]) => console.log(`[arkiv] on: chain ${id}, namespace ${config.prefix}, funder ${funder} (${formatEther(bal)} tGLM), receipts from ${receipt}; queued ${sync.backfill()} to mirror`))
      .catch((e) => console.error(`[arkiv] unreachable at startup (${scrub(e, config.accessKey)}); writes wait in the outbox`));
  }
  // Hourly; every 30 s with dev-only listing minutes, so a renewal can be watched live.
  const sweep = setInterval(() => sync.backfill(), listingMs ? 30_000 : 3_600_000);
  sweep.unref();
  const reads = new ArkivReads({ client, sync, keystore, data: core.data, prefix: config.prefix });
  return { sync, reads, keystore, stop: () => (clearInterval(sweep), sync.stop()) };
}

/**
 * Hedera x402 payments, with PAYMENTS=hedera (testnet only): every new release is paid by the brand agent's x402 client
 * to the creator's Hedera account, through the facilitator (X402_FACILITATOR_URL, default https://x402.org/facilitator).
 * Without it, DevPayment records payments and no money moves.
 */
/** Whitechain payments: the rail for the release step, with the public demo's USDT top-ups from the operator. */
function startWhitechain(opts: RuntimeOptions, accounts: Accounts, core: Core, keystore: Keystore | undefined, config: WhitechainConfig, demo?: Demo) {
  if (!keystore) throw new Error("Whitechain payments need FACEVISA_KEYSTORE_PASSWORD_FILE (each account's Whitechain key is its custodial key)");
  if (opts.mode === "mainnet") throw new Error("Whitechain payments are testnet only (Whitechain Sepolia)");
  const rail: WhitechainRail = new WhitechainRail({
    data: core.data,
    accounts,
    keystore,
    config,
    ...(opts.whitechain?.client ? { client: opts.whitechain.client } : {}),
    ...(opts.whitechain?.receiptMs ? { receiptMs: opts.whitechain.receiptMs } : {}),
    ...(opts.whitechain?.pollMs ? { pollMs: opts.whitechain.pollMs } : {}),
    // Sent but not confirmed within the wait: keep watching now (not only after a restart); the chain decides.
    onPending: (p) => {
      void rail.reconcile(p, { finish: (pay, ref) => void core.pipeline.finish(pay.actionId, pay, ref, WHITECHAIN_RAIL), abandon: (pay, why) => core.pipeline.abandon(pay.actionId, pay, why) }).catch((e) => console.error(`[whitechain] ${p.id}: ${(e as Error).message.split("\n")[0]}`));
    },
    // The public demo: a public account's brand is topped up with USDT from the operator, within the demo's caps.
    ...(demo
      ? {
          topUp: async (brand: string, address: `0x${string}`, have: bigint, price: bigint) => {
            if (!isPublicAccount(accounts.account(brand)?.iss)) return undefined;
            const t = demo.topUpFor(brand, have, price);
            if ("refused" in t) return t.refused;
            if (t.units === 0n) return true as const;
            const tx = await rail.sendUsdt(address, t.units);
            demo.recordTopUp(brand, address, t.units, tx);
            core.data.log({ brand, actionId: null, licenceId: null, kind: "funded", summary: `topped up with ${(Number(t.units) / 1e6).toFixed(2)} USDT on Whitechain from the demo's budget: ${tx}` });
            return true as const;
          },
        }
      : {}),
  });
  // The agent's release pays through the pipeline with this rail (no HTTP handshake: the brand never sees a chain).
  core.agent.d.pay = (id, brand) => core.pipeline.release(id, brand, rail);
  if (!opts.whitechain) console.log(`[whitechain] payments on (Whitechain Sepolia): settlement ${config.settlement}, USDT ${config.usdt}, relayer ${rail.relayer.address}, caps ${Number(config.maxPerPayment) / 1e6}/payment, ${Number(config.maxPerDay) / 1e6}/day`);
  return rail;
}

function startX402(opts: RuntimeOptions, accounts: Accounts, core: Core, store: RenderStore, keystore: Keystore | undefined, namespace: string, demo?: Demo) {
  const config = opts.hedera?.config ?? hederaConfigFromEnv(opts.root);
  if (!config) throw new Error("PAYMENTS=hedera needs HEDERA_OPERATOR_ID and the operator's key file (.secrets/hedera-operator-key)");
  if (!keystore) throw new Error("PAYMENTS=hedera needs FACEVISA_KEYSTORE_PASSWORD_FILE (each account's Hedera key is its custodial key)");
  if (opts.mode === "mainnet") throw new Error("Hedera x402 is testnet only");
  const fetchFn = opts.hedera?.fetch;
  const hedera = new Hedera(config, { accounts, keystore, ...(fetchFn ? { fetch: fetchFn } : {}), ...(demo ? { mayCreate: () => demo.takeHederaAccount() } : {}) });
  const facilitator = opts.hedera?.facilitator ?? new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator", timeoutMs: 60_000 });
  const ads = new X402Ads({ data: core.data, pipeline: core.pipeline, store, hedera, keystore, facilitator, publicUrl: opts.publicUrl, ...(opts.hedera?.pollMs ? { pollMs: opts.hedera.pollMs } : {}) });
  const payer = new X402Payer({
    data: core.data,
    keystore,
    hedera,
    // The agent calls its own endpoint over HTTP, as any x402 client would.
    baseUrl: opts.hedera?.baseUrl ?? `http://127.0.0.1:${Number(process.env.PORT || 8788)}`,
    dailyBudget: core.agent.d.dailyBudget,
    spendLimit: core.agent.d.spendLimit,
    creatorName: core.agent.d.creatorName,
    // The public demo: a demo brand is topped up from the operator, within the per-brand and the day's limits.
    ...(demo
      ? {
          topUp: async (brand: string, account: string, have: bigint, price: bigint) => {
            if (!isPublicAccount(accounts.account(brand)?.iss)) return undefined;
            const t = demo.topUpFor(brand, have, price);
            if ("refused" in t) return t.refused;
            if (t.units === 0n) return true as const;
            const tx = await hedera.sendUsdc(account, t.units);
            demo.recordTopUp(brand, account, t.units, tx);
            core.data.log({ brand, actionId: null, licenceId: null, kind: "funded", summary: `topped up with ${(Number(t.units) / 1e6).toFixed(2)} testnet USDC from the demo's budget (from the operator ${config.operatorId}): ${tx}` });
            return true as const;
          },
        }
      : {}),
  });
  core.agent.d.pay = (id, brand) => payer.pay(id, brand);
  const audit = new AuditLog({ db: accounts.db, data: core.data, accounts, keystore, writer: opts.hedera?.writer ?? hedera, namespace, methodOf: consentMethod });
  if (!opts.hedera) console.log(`[hedera] x402 on (testnet): operator ${config.operatorId}, USDC ${config.usdc}, facilitator ${process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator"}`);
  return { hedera, ads, payer, audit };
}
