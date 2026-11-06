/**
 * In-app approvals: the signed-in person confirms the decision in Likeness. Two of them, the same rules as before:
 *
 * - creator: the creator sees the FINISHED ad (not released) and approves, rejects (one regeneration) or denies it.
 *   An approval names the exact file the page showed (its hash): if the ad changed, it's refused. The approval is
 *   bound to that output's hash, the brand, usage, duration and price (approvalHashOf), and recorded once.
 * - spend: when the price is over the brand workspace's limit, the agent pauses until the brand's own signed-in person
 *   approves that exact amount (the page sends back the amount it showed).
 *
 * Who may decide is the session's account (and every POST carries the session's CSRF token): only the request's
 * creator decides the ad, only its brand decides the spend. Nothing is released or paid without the recorded approval
 * (pipeline.release refuses with 403). Deny, expiry and cancel release nothing and charge nothing.
 *
 * Labels: "approved by the creator in Likeness", "spend approved by the brand". Never World ID: World ID appears
 * only as the IDKit check before a creator lists (presence.ts).
 */
import { randomBytes } from "node:crypto";
import type { Accounts } from "./accounts.js";
import type { BrandAgent } from "../likeness/brandAgent.js";
import type { Evidence, LikenessData, PendingAction, Stage } from "../likeness/data.js";
import { approvalHashOf, type ConsentCheckpoint } from "../likeness/pipeline.js";
import { parseUsd, usd } from "../likeness/rules.js";

/** What an in-app approval records as its evidence (acr): the signed-in person confirmed it in Likeness. */
export const IN_APP = "likeness-in-app";

export class ApprovalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// "verified" and "spend_verified" are the states a request was in after a fresh check under the old flow: still
// decidable, so nothing in flight is stranded.
const OPEN: Record<Stage, PendingAction["status"][]> = { creator: ["review", "verified"], spend: ["spend_review", "spend_verified"] };

export interface ApprovalDeps {
  data: LikenessData;
  accounts: Accounts;
  agent: BrandAgent;
}

export class Approvals implements ConsentCheckpoint {
  readonly name = "in-app" as const;
  constructor(readonly d: ApprovalDeps) {}

  opened(_a: PendingAction) {
    // The agent waits; the creator decides from their request page.
  }

  /** The request, if this person decides its stage: the creator for the ad, the brand for the spend. */
  private own(uid: string, actionId: string, stage: Stage): PendingAction {
    this.d.agent.sweep();
    const a = this.d.data.action(actionId);
    if (!a || (stage === "creator" ? a.creator : a.brand) !== uid) throw new ApprovalError(404, "no such request");
    if (!OPEN[stage].includes(a.status)) throw new ApprovalError(409, `this request is ${a.status.replace("_", " ")}`);
    if (a.expiresAt <= Date.now()) throw new ApprovalError(409, "this request expired");
    return a;
  }

  /** Records who confirmed, and when, bound to the output (creator) or the amount (spend): the approval's evidence. */
  private record(a: PendingAction, uid: string, stage: Stage) {
    const acct = this.d.accounts.account(uid)!;
    const now = Date.now();
    const state = `in-app-${randomBytes(8).toString("hex")}`;
    const evidence: Evidence = { iss: acct.iss, sub: acct.sub, authTime: Math.floor(now / 1000), amr: [], acr: IN_APP, attemptId: state, verifiedAt: now, ...(stage === "creator" ? { outputHash: a.output!.hash } : { amount: a.price }) };
    if (!this.d.data.setAttempt(a.id, stage, state, now) || !this.d.data.setVerified(a.id, stage, state, evidence)) throw new ApprovalError(409, "this request changed; reload it");
  }

  /**
   * The creator's decision on the finished ad they saw (`outputHash`): approve (bound to that output's hash, the brand,
   * usage, duration and price), reject (the agent regenerates once; a second rejection ends the request), or deny.
   */
  decide(creator: string, actionId: string, decision: "approve" | "reject" | "deny", outputHash?: string): PendingAction {
    const a = this.own(creator, actionId, "creator");
    if (decision !== "deny") {
      if (!a.output) throw new ApprovalError(409, "the ad isn't ready yet");
      if (!outputHash || outputHash.toLowerCase() !== a.output.hash.toLowerCase()) throw new ApprovalError(409, "the ad changed since you opened it: reload it and look again");
    }
    if (decision === "approve") {
      this.record(a, creator, "creator");
      if (!this.d.data.approve(a.id, approvalHashOf(a), this.d.agent.needsSpendApproval(a.price))) throw new ApprovalError(409, "this request changed; reload it");
      this.d.agent.onApproved(a.id);
    } else if (decision === "reject" && a.generation === 1) {
      if (!this.d.data.regenerate(a.id)) throw new ApprovalError(409, "this request changed; reload it");
      this.d.agent.onRejected(a.id);
    } else {
      const reason = decision === "reject" ? "the creator rejected the regenerated ad too" : "the creator denied the request";
      if (!this.d.data.transition(a.id, OPEN.creator, "denied", { reason })) throw new ApprovalError(409, "this request changed; reload it");
      this.d.data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "denied", summary: `${reason} in Likeness: nothing released, nothing charged` });
    }
    return this.d.data.action(a.id)!;
  }

  /** The brand's person decides a spend over the limit, for the amount they saw: approve (pay and release) or deny. */
  decideSpend(brand: string, actionId: string, decision: "approve" | "deny", amount?: string): PendingAction {
    const a = this.own(brand, actionId, "spend");
    if (decision === "approve") {
      if (amount === undefined || parseUsd(amount) !== a.price) throw new ApprovalError(409, `the amount changed since you opened it (it's ${usd(a.price)} now): reload it`);
      this.record(a, brand, "spend");
      if (!this.d.data.approveSpend(a.id)) throw new ApprovalError(409, "this request changed; reload it");
      this.d.agent.onSpendApproved(a.id);
    } else {
      if (!this.d.data.transition(a.id, OPEN.spend, "denied", { reason: "the brand denied the spend" })) throw new ApprovalError(409, "this request changed; reload it");
      this.d.data.log({ brand: a.brand, actionId: a.id, licenceId: null, kind: "denied", summary: `the brand denied spending ${usd(a.price)}: nothing spent, nothing released` });
    }
    return this.d.data.action(a.id)!;
  }
}
