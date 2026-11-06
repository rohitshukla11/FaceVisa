/**
 * The brand agent's audit log on Hedera (HCS, testnet), with HEDERA_X402=1: one topic per database, created by the
 * operator (its admin and only submitter; memo names the namespace). These activity-log events become one message
 * each:
 * - requested, approved, denied, paid (with the transaction ID), released (with the licence);
 * - spend-check (paused above BRAND_STEPUP_USDC) and spend-approved (the brand's human);
 * - blocked, with a reason code.
 * A check's method is labelled: "standin" (the local World ID stand-in) or "demo" (the public demo), both test identities, or "world-id".
 *
 * A message is IDs and addresses only: the request, licence and transaction IDs, and the brand's and creator's
 * Hedera accounts (or their key's address before they have one). No brief, no names, no free text: a blocked event
 * carries a code, not its summary.
 *
 * Durable: each event is queued in `hcs_audit` and sent in order by one worker, retried every minute while the
 * network fails. Events from before the log was on aren't sent.
 */
import { isInApp } from "../app/approval.js";
import type { DatabaseSync } from "node:sqlite";
import type { Accounts } from "../app/accounts.js";
import type { Keystore } from "../app/keystore.js";
import type { AgentEvent, AgentEventKind, FaceVisaData } from "../facevisa/data.js";
import { hashscan } from "./hedera.js";

const AUDITED: AgentEventKind[] = ["requested", "approved", "denied", "spend-check", "spend-approved", "paid", "released", "blocked"];

/** Why the agent was blocked, as a code: what an audit message says instead of the event's own text. */
export function blockedCode(summary: string): string {
  const codes: [RegExp, string][] = [
    [/daily budget/, "daily-budget"],
    [/step-up|over this workspace's limit/, "step-up"],
    [/the 402 asks for/, "payment-mismatch"],
    [/payment didn't happen/, "payment-voided"],
    [/payment refused|didn't verify|settlement|not the brand's account/, "payment-refused"],
    [/isn't the approved ad/, "file-mismatch"],
    [/checkpoint failed/, "checkpoint-failed"],
    [/revoked licence/, "revoked"],
    [/not sent:/, "request-refused"],
  ];
  return codes.find(([re]) => re.test(summary))?.[1] ?? "other";
}

export interface TopicWriter {
  createTopic(memo: string): Promise<string>;
  submitMessage(topicId: string, message: string): Promise<{ txId: string; seq: number }>;
}

export class AuditLog {
  private running: Promise<void> | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly o: { db: DatabaseSync; data: FaceVisaData; accounts: Accounts; keystore: Keystore; writer: TopicWriter; namespace: string; methodOf?: (iss: string) => string; autoRun?: boolean },
  ) {
    o.db.exec("create table if not exists hcs_audit (event_id integer primary key, status text not null, seq integer, tx_id text, error text, sent_at integer)");
    const prior = o.data.onEvent;
    o.data.onEvent = (e) => {
      prior?.(e);
      this.record(e);
    };
    this.timer = setInterval(() => void this.flush(), 60_000);
    this.timer.unref();
  }

  get topic(): string | null {
    return (this.o.db.prepare("select value from meta where key = 'hedera_audit_topic'").get() as { value: string } | undefined)?.value ?? null;
  }

  topicUrl() {
    const t = this.topic;
    return t ? hashscan.topic(t) : null;
  }

  private record(e: AgentEvent) {
    if (!AUDITED.includes(e.kind)) return;
    this.o.db.prepare("insert or ignore into hcs_audit (event_id, status) values (?, 'pending')").run(e.id);
    if (this.o.autoRun !== false) void this.flush();
  }

  /** An account as the log names it: its Hedera account, or its key's address before it has one. Never a name. */
  private who(uid: string | null | undefined) {
    if (!uid) return null;
    return this.o.accounts.hederaAccount(uid) ?? this.o.keystore.address(`account:${uid}`) ?? null;
  }

  /** The message for an event: IDs and addresses only. */
  message(e: AgentEvent) {
    const a = e.actionId ? this.o.data.action(e.actionId) : undefined;
    const paid = e.kind === "paid" && a ? this.o.data.payments({ actionId: a.id }).filter((p) => p.status === "settled").at(-1) : undefined;
    // How the deciding check was made: the creator's (approved, denied) or the brand's human's (spend-approved).
    const brandDenied = e.kind === "denied" && /^the brand('s human)? denied/.test(e.summary);
    const ev = e.kind === "spend-approved" || brandDenied ? a?.spendCheck?.evidence : e.kind === "approved" || e.kind === "denied" ? a?.creatorCheck.evidence : undefined;
    return JSON.stringify({
      v: 1,
      app: "facevisa",
      ns: this.o.namespace,
      event: e.kind,
      at: new Date(e.at).toISOString(),
      request: e.actionId,
      ...(e.licenceId ? { licence: e.licenceId } : {}),
      brand: this.who(e.brand),
      ...(a ? { creator: this.who(a.creator) } : {}),
      ...(a && (e.kind === "spend-check" || e.kind === "spend-approved") ? { amount: a.price } : {}),
      // Who approved, in FaceVisa: the signed-in person's identity (dev, demo), never World ID.
      ...(ev && this.o.methodOf ? { approval: isInApp(ev.acr) ? "in-app" : ev.iss === "dev-consent" ? "dev-consent" : "checkpoint", identity: this.o.methodOf(ev.iss) } : {}),
      ...(paid ? { rail: paid.rail, tx: paid.ref, amount: paid.amount } : {}),
      ...(e.kind === "blocked" ? { reason: blockedCode(e.summary) } : {}),
    });
  }

  /** Sends what's pending, in order, one worker at a time. */
  flush(): Promise<void> {
    this.running ??= this.send().finally(() => (this.running = undefined));
    return this.running;
  }

  private async send() {
    const { db, writer } = this.o;
    let topic = this.topic;
    for (;;) {
      const row = db.prepare("select h.event_id, e.brand, e.action_id, e.licence_id, e.kind, e.summary, e.at from hcs_audit h join agent_events e on e.id = h.event_id where h.status = 'pending' order by h.event_id limit 1").get() as Record<string, unknown> | undefined;
      if (!row) return;
      const e: AgentEvent = { id: Number(row.event_id), brand: row.brand as string, actionId: (row.action_id as string | null) ?? null, licenceId: (row.licence_id as string | null) ?? null, kind: row.kind as AgentEventKind, summary: row.summary as string, at: Number(row.at) };
      try {
        if (!topic) {
          topic = await writer.createTopic(`FaceVisa: the brand agent's audit log (testnet, ${this.o.namespace})`);
          db.prepare("insert into meta (key, value) values ('hedera_audit_topic', ?)").run(topic);
          console.log(`[hedera] audit log topic ${topic}: ${hashscan.topic(topic)}`);
        }
        const r = await writer.submitMessage(topic, this.message(e));
        db.prepare("update hcs_audit set status = 'sent', seq = ?, tx_id = ?, error = null, sent_at = ? where event_id = ?").run(r.seq, r.txId, Date.now(), e.id);
      } catch (err) {
        db.prepare("update hcs_audit set error = ? where event_id = ?").run((err as Error).message.split("\n")[0]!, e.id);
        console.error(`[hedera] audit message for event ${e.id} not sent (retried in a minute): ${(err as Error).message.split("\n")[0]}`);
        return;
      }
    }
  }

  /** What's been sent and what's waiting. */
  status() {
    const n = (s: string) => Number((this.o.db.prepare("select count(*) as n from hcs_audit where status = ?").get(s) as { n: number }).n);
    return { topic: this.topic, url: this.topicUrl(), sent: n("sent"), pending: n("pending") };
  }

  stop() {
    clearInterval(this.timer);
  }
}
