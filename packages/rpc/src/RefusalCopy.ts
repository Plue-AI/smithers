/**
 * What the app SAYS about a refusal, in one table, keyed by whose fault it is.
 *
 * The refusing party's own words are never rewritten — the workspace card's
 * standing rule is "plue's own words, verbatim", and they still render
 * underneath. What this file adds is the one sentence those words cannot
 * carry: whose problem this is. "service unavailable" reads identically
 * whether the caller asked for something they may not have, whether the thing
 * simply is not ready yet, or whether Smithers' own fleet is full — and a
 * person cannot act on it, or stop blaming themselves for it, until somebody
 * says which.
 *
 * Three consumers, one row: `lead` is the line the interface puts above the
 * server's words, `agent` is the sentence the chat model is handed with the
 * tool result so it states the fault class instead of inferring it from prose,
 * and `doors` is which ways out the surface offers.
 *
 * The table is keyed by fault and overridden per code, not written per code:
 * there are a hundred-odd codes and five faults, and the fault is the part a
 * person acts
 * on. `satisfies Record<PlueFault, RefusalCopyRow>` means a fault plue adds
 * has no copy until somebody writes it, which is a compile error rather than a
 * blank line in front of a user.
 *
 * `infra` is where that stops being enough, and every one of its codes has a
 * written row below. The fault says whose problem it is, which is true of all
 * of them; it does not say WHAT went wrong, and infra failures differ there
 * more than any other fault does. A fleet with no free slots, a deployment
 * nobody migrated, a box on last month's image and a component that is not
 * answering are one fault and four different sentences — and for a long time
 * they shared the first one, so a reader whose wiki backend was down was told
 * Smithers had run out of infra and that somebody should buy more of it.
 * Nothing was full. The fault's own lead is now the vague-but-true line a new
 * code inherits until somebody writes its row.
 *
 * The Cloudflare Worker's OWN refusals go further and REQUIRE a written lead
 * (WORKER_REFUSAL_COPY below), because there is no registry doc behind them to
 * write one from later.
 *
 * @since 1.0.0
 */

import type { PlueFailureCode, PlueFault } from "./PlueFailureCodes.ts"
import { isNativeFailureCode, isWorkerFailureCode, refusalCode, refusalEntry } from "./Refusal.ts"
import type { Refusal, RefusalOrigin } from "./Refusal.ts"
import { USER_FAILURE_ACTIONS } from "./UserFailure.ts"
import type { UserFailure, UserFailureAction } from "./UserFailure.ts"
import type { WorkerFailureCode } from "./WorkerFailureCodes.ts"

/**
 * The line for a real shortage of infra, in one place so it can be reworded in
 * one place.
 *
 * This is the product owner's ruling, close to verbatim: say plainly that it
 * is NOT the user's fault and that the fix is more infra, by name. It is
 * deliberately not corporate — "we're experiencing higher than usual demand"
 * is the sentence that makes a person think they did something wrong, and a
 * full fleet is the one failure where they certainly did not.
 *
 * It belongs to `no_capacity` and to nothing else. The ruling's other half is
 * that the sentence be TRUE, and "we ran out, buy more" is a claim about a
 * shortage: on every other infra code nothing is full, and pointing a reader
 * at @fucory sends them after a problem that does not exist and a fix that
 * would not work. RefusalCopy.test.ts checks both directions.
 *
 * It is words only for now. Whether "Tell @fucory" is a real door — a button
 * that files something — has not been ruled on, so nothing here renders a
 * control; `RefusalDoor`'s `report` member is the seam where one would attach.
 *
 * @since 1.0.0
 * @category constants
 */
export const INFRA_NOT_YOUR_FAULT = "This is not your fault — Smithers ran out of infra. Yell at @fucory to buy more."

/**
 * The line for a request nothing answered at all.
 *
 * This is `infra` by fault — nobody judged the request, so the reader cannot
 * be blamed for it — but it is NOT the failure INFRA_NOT_YOUR_FAULT describes,
 * and for a while it borrowed that sentence anyway. A fetch that dies on an
 * offline laptop, a DNS failure or a socket hang up told the reader "Smithers
 * ran out of infra", which is a claim about OUR capacity that we are in no
 * position to make: nothing answered, so nothing is known about the fleet at
 * all. The whole point of the owner's line is that the message is true about
 * whose fault it is; a false half makes the true half worth less.
 *
 * What is true of every one of these, by construction: no answer came back,
 * that is the connection rather than anything the reader did, and it is worth
 * asking again.
 *
 * @since 1.0.0
 * @category constants
 */
export const NOTHING_ANSWERED = "Nothing answered at all — that's the connection, not something you did. Try it again."

/**
 * A way out of a refusal, offered by whichever surface is rendering it.
 *
 * @since 1.0.0
 * @category models
 */
export type RefusalDoor =
  /** Run the same request again, by hand. */
  | "upgrade"
  | "retry"
  /** The box is not running; start it and try again. */
  | "resume"
  /** The session is the problem, not the request. */
  | "sign-in"
  /**
   * This box cannot do it and never will; a new one, on the current image,
   * can. The only door for a refusal plue calls terminal for that box.
   */
  | "new-box"
  /*
   * Somebody at Smithers needs to know. NOT YET A CONTROL: no surface renders
   * a button for this door, because whether "Tell @fucory" files something or
   * merely says something is the product owner's call and has not been made.
   * It is carried in the table so the decision has exactly one place to land —
   * a surface's door switch gains a case, and every infra and bug refusal in
   * the app has the affordance at once.
   */
  | "report"

/**
 * What the app says about one class of refusal.
 *
 * @since 1.0.0
 * @category models
 */
export interface RefusalCopyRow {
  /** The line the interface adds ABOVE the refusing party's own words. Never replaces them. */
  readonly lead: string
  /** The sentence handed to the chat model with the tool result, so it is told the fault class rather than guessing it. */
  readonly agent: string
  /**
   * The ways out this refusal licenses.
   *
   * `retry` here is the HUMAN's re-ask — a button they press after they have
   * changed something or decided to stop waiting. It is not permission for the
   * app or the model to re-run anything on its own: that is `mayAutoRetry`,
   * which only ever says yes to a `wait` fault, and the `agent` sentence
   * above, which tells the model when not to.
   */
  readonly doors: ReadonlyArray<RefusalDoor>
}

/**
 * The copy for each fault. Every fault must have a row; a new one does not compile until it does.
 *
 * @since 1.0.0
 * @category constants
 */
export const REFUSAL_COPY = {
  user: {
    lead: "Smithers can't do that as asked.",
    agent:
      "fault=user: the request itself has to change — running it again unchanged fails the same way. Tell the user what to change. Do not apologise for a platform failure; this was not one.",
    doors: ["retry"]
  },
  wait: {
    lead: "Not ready yet — nothing is wrong.",
    agent:
      "fault=wait: nothing is broken, it just is not ready yet, and the server said how long to wait. The app is already waiting where it is allowed to; do not re-run it in a loop.",
    doors: ["retry"]
  },
  /*
   * The default is the SAFE half of the ruling, not the whole of it. "Not your
   * fault" is true of every infra refusal by construction; "we ran out, yell at
   * @fucory to buy more" is true of exactly one of them, and for a long time
   * every infra code inherited it — a deployment that was never migrated, a box
   * on an old image and a component that was not answering all told the reader
   * that Smithers was full and that somebody should buy more of it. None of
   * them were, and the fix was never a purchase.
   *
   * So the shortage sentence lives on `no_capacity`, which is the code that
   * reports one, and a code plue adds tomorrow inherits a line that is vague
   * rather than one that is false. Vague is recoverable by writing a row below;
   * false is not recoverable by anything the reader can do.
   */
  infra: {
    lead: "Something on Smithers' side failed. Not your fault, and nothing your request could have changed.",
    agent:
      "fault=infra: Smithers' own infrastructure failed, NOT the user. Say plainly that this is not their fault and not their request's. Nothing is known to be full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it — only the code for a capacity shortage licenses that. Do not suggest they change their request, and do not retry it on a timer.",
    doors: ["retry", "report"]
  },
  dependency: {
    lead: "Something Smithers depends on failed. Not your doing.",
    agent:
      "fault=dependency: a service Smithers depends on (GitHub, a model provider, billing) failed or throttled us. Not the user's doing and not their request's. Say which one if the message names it, and that it is worth trying again later.",
    doors: ["retry"]
  },
  bug: {
    lead: "That's a bug in Smithers, not something you did.",
    agent:
      "fault=bug: Smithers is defective here. Do not blame the user, do not invent a workaround, and do not dress the internal message up as an explanation.",
    doors: ["retry", "report"]
  },
  factory: {
    lead: "Smithers could not finish this one. Not your fault.",
    agent:
      "fault=factory: Smithers' own work on this did not converge (a stalled plan, an unproven result). Not the user's fault and not their request's. Say it plainly; retrying replans it.",
    doors: ["retry"]
  },
  policy: {
    lead: "A cap stopped this. Not your fault.",
    agent:
      "fault=policy: a spend or time cap the owner set stopped this, and it stays stopped. Nothing is broken. Say which cap if the message names it; the person raising the cap, or pressing Retry, resumes the work. Do not retry on a timer.",
    doors: ["retry"]
  }
} satisfies Record<PlueFault, RefusalCopyRow>

/*
 * Four codes, one sentence, on purpose. `runtime_error`, `worker_error`,
 * `worker_draining` and `host_lease_lost` are all the machine behind the box:
 * its runtime driver failed, the controller lost its lease on it, it is being
 * drained, or there is no more specific word for it. A reader cannot tell them
 * apart from outside and does not need to — every one of them is one machine
 * rather than the fleet, and plue says the remedy itself in the registry:
 * "Another worker may well succeed."
 */
const MACHINE_BEHIND_THE_BOX =
  "The machine behind your box couldn't take that. Not your fault — trying again can land on a different one."

const MACHINE_BEHIND_THE_BOX_AGENT =
  "fault=infra: the machine behind this box failed or refused the operation — a runtime driver fault, a lost host lease, a machine being drained, or one Smithers has no more specific word for; its own message says which. This is ONE machine, not the fleet: nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Not the user's fault and not their request's. Another machine may well succeed, so it is worth asking again; do not suggest they change what they asked for."

/*
 * Two codes for one check: Smithers could not read the box's native source at
 * all, or the box answered about a different revision than the one asked for.
 * Neither records anything, and the act after both is to ask again.
 */
const SOURCE_NOT_CONFIRMED =
  "Smithers couldn't confirm the source this box was opened from. Not your fault — nothing was recorded, and it's worth asking again."

const SOURCE_NOT_CONFIRMED_AGENT =
  "fault=infra: Smithers could not verify the box's native source, or the box acknowledged a different revision than the one requested. Nothing was recorded either way. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. It is worth asking again; do not suggest they change what they asked for."

/*
 * The codes whose fault does not say enough on its own. A row here overrides
 * only the fields it names — the fault's row still supplies the rest — and a
 * code that is not one of plue's does not compile.
 */
const BY_CODE: Partial<Record<PlueFailureCode, Partial<RefusalCopyRow>>> = {
  /* repo-host refuses writes to a repository it holds for a few seconds; the app retries. */
  repository_held: {
    lead: "Repository is busy, retrying.",
    agent:
      "fault=wait: the repository refuses writes for a few seconds while maintenance finishes; reads still work. Nothing was changed. Retry after the server's Retry-After; do not tell the user they did anything wrong.",
    doors: ["retry"]
  },
  /* The account is at its sandbox plan limit: the way out is an upgrade, never a retry. */
  plan_limit_exceeded: {
    lead: "Your plan is at its sandbox limit.",
    agent:
      "fault=user: the account reached its sandbox plan limit. Offer billing.plans so the human can upgrade, or suspend a sandbox. Do not retry automatically.",
    doors: ["upgrade"]
  },
  /*
   * The one a full fleet produces, and the reason this file exists. It takes
   * the infra lead unchanged; what it adds is that the box itself survived, so
   * nobody reads "no capacity" as "my work is gone".
   */
  no_capacity: {
    lead: INFRA_NOT_YOUR_FAULT,
    agent:
      "fault=infra: every box in the fleet is full — the user's own box and its disk are untouched. Say plainly that this is not their fault and that the fix is more infra: yell at @fucory to buy more. Do not retry it on a timer.",
    doors: ["retry", "report"]
  },
  /*
   * The user-fault twin of no_capacity, and the one that must NEVER show the
   * infra line: this account is at its own cap, which is a fact about them and
   * is fixed by them.
   */
  quota_exceeded: {
    lead: "Your account is at its cap — this one is yours to clear.",
    agent:
      "fault=user: THIS ACCOUNT is at a per-resource cap (for example, how many boxes it may keep running) — this is not the fleet being full. Tell them what to free up. Never tell them it is not their fault and never mention buying more infra.",
    doors: []
  },
  /* Plue's model proxy refused a metered call; the Worker relays the code unchanged. */
  out_of_credit: {
    lead: "Out of credit.",
    agent:
      "fault=user: the account's model credit is spent. Offer billing.plans so the human can add credit. Do not retry.",
    doors: ["upgrade"]
  },
  rate_limit_exceeded: { lead: "You're going faster than Smithers allows. Give it a minute.", doors: ["retry"] },
  /*
   * `infra`, like a full fleet, and it must NOT read like one. This box booted
   * an image from before the desktop helpers shipped, and it is still healthy:
   * nothing is full, nothing is down, and telling a reader to yell for more
   * infra points them at a problem that does not exist. What IS true is that
   * we have not rebuilt and re-registered that image yet, so it is ours and
   * not theirs — and that plue calls it terminal for this box, which makes a
   * Retry a door onto a wall. A new box boots the current image and has them.
   */
  desktop_tools_unavailable: {
    lead:
      "This box predates Smithers' desktop tools. Not your fault — and no retry adds them to it. A new box comes with them.",
    agent:
      "fault=infra: this BOX booted an image older than the desktop tools, because Smithers has not rebuilt and re-registered that image yet. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically on this box forever — tell them to open a new box, which boots the current image and has the tools.",
    doors: ["new-box", "report"]
  },
  workspace_rebuild_required: {
    lead: "This box was built with a subscription token. Delete it and open a new one.",
    agent:
      "fault=user: this BOX (or the snapshot it came from) was built while the repository stored a Claude or ChatGPT subscription token, which may still be on its disk, so Smithers will not reuse it. Retrying fails identically. Tell them to delete this box and open a new one; if the repository still holds the token, they must remove it first.",
    doors: ["new-box"]
  },
  /*
   * The same rollout lag one step earlier: no image is registered for the kind
   * at all, so no box of it can boot here. There is no box to open and nothing
   * the reader can do from their side, which is the part the sentence carries.
   */
  environment_image_unavailable: {
    lead:
      "Smithers has no image built for this kind of box yet. Not your fault, and not something you can fix from here.",
    agent:
      "fault=infra: this DEPLOYMENT has no registered image for the kind of box being opened, so none can boot here until Smithers builds and registers one. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically until Smithers registers an image; do not offer to try again and do not suggest they change what they asked for.",
    doors: ["report"]
  },
  /*
   * The same rollout lag on the coding side, and plue called it the caller's
   * fault until 2026-09-14 — "update its provisioned runtime", said to someone
   * who provisioned nothing. plue stages the coding host and its adapter into
   * the box from the API pod's own filesystem; no repository and no person
   * picks, pins or edits either. A box staged before the current artifact
   * shipped refuses a good request, and no re-ask against that box changes it.
   */
  coding_host_unavailable: {
    lead:
      "This box's coding tools are older than the ones Smithers needs. Not your fault — retrying won't update them, and a box opened now comes with the current ones.",
    agent:
      "fault=infra: the coding host and adapter STAGED INTO THIS BOX by Smithers are older than the operation requires, or never registered the coding capability. Smithers stages both; the user picked nothing and provisioned nothing. Not their fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically on this box — a box opened now is staged with the current artifact.",
    doors: ["report"]
  },
  /*
   * The other half of that refusal, split out of it in the same pass. An API
   * pod with no health-probe URL configured cannot verify ANY box's coding
   * gateway, so it refuses every one of them, for every account, until an
   * operator sets the variable. It used to borrow the sentence above and send
   * a reader off to update a box nothing had even looked at.
   */
  coding_gateway_not_configured: {
    lead:
      "This deployment of Smithers can't check a box's coding gateway, so it won't open one. Not your fault, and not something you can switch on from here.",
    agent:
      "fault=infra: this DEPLOYMENT has no workspace-gateway health probe configured, so it refuses every bound coding gateway rather than answer for one it cannot verify. The user's box was never inspected — do NOT tell them to update, re-provision or replace it. Not their fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically until whoever deployed it configures the probe.",
    doors: ["report"]
  },
  /*
   * Rollout lag inside a RUNNING box: the guest kept a reporter from before
   * Smithers' last upgrade. plue's own doc says the start/resume path installs
   * and restarts the current one, so the reader has a cheap fix — and a Retry
   * against the box as it stands is not it.
   */
  coding_reporter_upgrade_required: {
    lead:
      "This box is still running a reporter from before Smithers' last update. Not your fault — stop the box and start it again, and it picks up the current one.",
    agent:
      "fault=infra: this BOX kept a coding reporter older than the API talking to it, because Smithers upgraded the API without re-staging the guest component. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying as it stands fails identically — tell them to stop the box and start it again, which installs the current reporter. Reading revisions still works meanwhile.",
    doors: ["report"]
  },
  /*
   * The box's jj is older than the version plue's parser is pinned to, and
   * plue refuses to guess at output it does not recognise. The version comes
   * from the image, so no re-ask against this box moves it.
   */
  coding_unsupported_jj: {
    lead:
      "This box's jj is older than the one Smithers writes changes with. Not your fault — and no retry updates it; a new box boots the current one.",
    agent:
      "fault=infra: this BOX's jj is older than the version Smithers' parser is pinned to, and it refuses to guess rather than misread the output. The version comes from the image the box booted, which Smithers built. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically on this box — a box opened now boots the current image and its pinned jj.",
    doors: ["report"]
  },
  /*
   * Deployment shape, the three of them. Nothing is full, nothing is down, and
   * nothing the reader does changes any of it: a table was never migrated, a
   * credential was never set, a worker build never shipped the capability.
   * Each gets its own sentence because each rules out a DIFFERENT wrong move —
   * waiting, signing in again, changing the request.
   */
  feature_not_enabled: {
    lead:
      "This deployment of Smithers doesn't have that switched on. Not your fault, and not something you can switch on from here.",
    agent:
      "fault=infra: the storage this endpoint needs was never provisioned on this DEPLOYMENT, so the feature is off here — Smithers' own words name which one. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically until the deployment is migrated; say so rather than offering to try again.",
    doors: ["report"]
  },
  authentication_not_configured: {
    lead:
      "Smithers' own credentials for this deployment were never set up, so nothing here can be authorised. Not your fault — and signing in again won't change it.",
    agent:
      "fault=infra: this DEPLOYMENT's controller has no authentication material configured, so it refuses every authenticated call from everyone. It is NOT the user's session — never tell them to sign in again, sign out, or reconnect anything. Not their fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically until whoever deployed it sets the credential.",
    doors: ["report"]
  },
  secret_delivery_unavailable: {
    lead: "This build of Smithers can't put secrets into a box. Not your fault, and nothing you can change from here.",
    agent:
      "fault=infra: the worker BUILD running this box cannot deliver secrets into a guest at all — the capability is not in it. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Retrying fails identically on this build, and no change to their secret or their request helps.",
    doors: ["report"]
  },
  /*
   * The machine behind the box, four ways: its runtime driver failed, its
   * lease expired, it is being drained, or the controller has no more specific
   * word for it. One sentence, because the reader cannot tell them apart and
   * does not need to — the act is the same, and plue says so itself
   * ("Another worker may well succeed").
   */
  runtime_error: { lead: MACHINE_BEHIND_THE_BOX, agent: MACHINE_BEHIND_THE_BOX_AGENT, doors: ["retry", "report"] },
  worker_error: { lead: MACHINE_BEHIND_THE_BOX, agent: MACHINE_BEHIND_THE_BOX_AGENT, doors: ["retry", "report"] },
  worker_draining: { lead: MACHINE_BEHIND_THE_BOX, agent: MACHINE_BEHIND_THE_BOX_AGENT, doors: ["retry", "report"] },
  host_lease_lost: { lead: MACHINE_BEHIND_THE_BOX, agent: MACHINE_BEHIND_THE_BOX_AGENT, doors: ["retry", "report"] },
  /*
   * Two ways the same check fails: Smithers could not read the box's native
   * source, or the box answered about a different revision than the one asked
   * for. Same sentence — nothing was recorded either way, and the act is to
   * ask again.
   */
  workspace_source_unavailable: {
    lead: SOURCE_NOT_CONFIRMED,
    agent: SOURCE_NOT_CONFIRMED_AGENT,
    doors: ["retry", "report"]
  },
  workspace_source_invalid_ack: {
    lead: SOURCE_NOT_CONFIRMED,
    agent: SOURCE_NOT_CONFIRMED_AGENT,
    doors: ["retry", "report"]
  },
  /*
   * The box would have had no way out to the network, so plue stopped rather
   * than run the work half-connected. Its own sentence because the reader may
   * otherwise read a failed install or fetch inside the box as their doing.
   */
  egress_proxy_unavailable: {
    lead:
      "Your box would have had no outbound network, so Smithers stopped instead of running it half-connected. Not your fault; worth trying again.",
    agent:
      "fault=infra: the box's egress proxy is not answering, so the box would have had no outbound network and Smithers refused rather than run the work without it. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Nothing about their network or their machine is involved. It is worth asking again.",
    doors: ["retry", "report"]
  },
  /*
   * The generic one, and deliberately generic: plue is up and something behind
   * it is not answering, with plue's own words naming which. A lead that
   * guessed harder than that would be guessing.
   */
  service_unavailable: {
    lead: "A piece of Smithers isn't answering right now. Not your fault; worth trying again in a moment.",
    agent:
      "fault=infra: Smithers is up but a component it needs is not answering — its own words say which. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. It is worth asking again shortly; do not suggest they change what they asked for.",
    doors: ["retry", "report"]
  },
  /*
   * Mid-rollout, and it clears on its own. The reader's repository is fine;
   * the sentence has to stop them going off to fix it.
   */
  repository_provisioning_rollout: {
    lead:
      "Smithers is mid-update here and isn't setting up repositories just now. Not your fault; it takes them again shortly.",
    agent:
      "fault=infra: repository provisioning is mid-rollout on this DEPLOYMENT and is not accepting new work. Nothing is wrong with the repository they named. Not their fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. It clears on its own; it is worth asking again shortly.",
    doors: ["retry", "report"]
  },
  /*
   * The four plue paces itself, with a Retry-After of a second or two in the
   * registry. A `report` door on a designed blip is noise, so they carry the
   * retry alone.
   */
  sse_unavailable: {
    lead:
      "Smithers couldn't open the live updates stream, so nothing here will move on its own. Not your fault; asking again usually opens it.",
    agent:
      "fault=infra: Smithers' event-stream tier could not open the stream, so the client gets no live updates. The stream was never established and no data was lost. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Opening it again usually works.",
    doors: ["retry"]
  },
  wiki_unavailable: {
    lead: "The wiki's backend isn't answering. Not your fault; try it again in a second.",
    agent:
      "fault=infra: the wiki's collaboration backend is not answering — Smithers' own words say what it was doing. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Smithers asks for a second's wait; asking again after that usually works.",
    doors: ["retry"]
  },
  /*
   * A control-plane write that kept losing a race, abandoned rather than
   * forced. Nothing changed, and plue's own doc says the identical request
   * works once the contention clears — which is exactly what the generic infra
   * line ("do not retry it on a timer") talks the reader out of.
   */
  sandbox_control_busy: {
    lead:
      "Smithers' box controller was busy with another write. Not your fault — nothing changed, and the same ask works in a moment.",
    agent:
      "fault=infra: a control-plane transaction lost a race with a concurrent writer and Smithers abandoned it rather than force it. NOTHING changed. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. The identical request works once the contention clears, so say plainly that it is worth asking again in a moment; do not suggest they change what they asked for.",
    doors: ["retry"]
  },
  /*
   * The one that reads like the reader's fault and is not: the limiter is
   * DOWN, and the endpoint turns work away rather than let a budget go
   * uncounted. Saying "you're going too fast" here would be a lie, and it is
   * the lie the status code invites.
   */
  rate_limiter_unavailable: {
    lead:
      "You're not over any limit — Smithers' rate limiter isn't answering, so it turned this away rather than let it through uncounted. Not your fault; try again in a second.",
    agent:
      "fault=infra: Smithers' rate-limit store is not answering and the endpoint fails closed, so this was turned away WITHOUT the user being over any budget. Never tell them they are going too fast or should slow down. Not their fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Smithers asks for a second's wait; asking again after that usually works.",
    doors: ["retry"]
  },
  /*
   * The honest awkward one. plue classes it infra, and the refusal is
   * certainly not a verdict on the request — but the gateway cannot tell its
   * own fault from a process inside the box that stopped listening, and the
   * copy must not pick one. See the report: whether this stays `infra` is a
   * product decision nobody has made.
   */
  preview_unavailable: {
    lead:
      "Smithers couldn't reach the preview port on your box. Not your fault — though it's worth checking your server is still listening before you try again.",
    agent:
      "fault=infra: the preview gateway could not reach the port the box is serving. Smithers classes this as ours and it is NOT a verdict on the user's request — but the gateway cannot tell a gateway fault from a process inside the box that stopped listening, so do NOT assert which it was. Nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Say what is known, and that checking the process is up is worth doing before asking again.",
    doors: ["retry", "report"]
  },
  /* The 409 the desktop facet has always offered Resume for: the box is stopped, not broken. */
  desktop_not_running: { lead: "That box isn't running.", doors: ["resume", "retry"] },
  retained_runtime_not_running: { lead: "That box isn't running.", doors: ["resume", "retry"] },
  unauthorized: { lead: "Smithers Cloud doesn't recognise this session.", doors: ["sign-in"] },
  invalid_token: { lead: "Smithers Cloud doesn't recognise this session.", doors: ["sign-in"] },
  github_reconnect_required: { lead: "GitHub needs reconnecting before this can run.", doors: ["sign-in"] }
}

/**
 * What the app says about one of the Cloudflare Worker's own refusals.
 *
 * `lead` is REQUIRED here, unlike plue's sparse overrides above. plue's codes
 * share five faults and the fault's own sentence is usually the whole truth;
 * the Worker's refusals are the ones where it is not. Two of its codes
 * are `infra` — `deployment_not_configured` and `seam_not_configured` — and
 * neither is the failure INFRA_NOT_YOUR_FAULT describes: nothing is full,
 * something was never wired, and telling a reader to yell for more infra would
 * point them at the wrong problem and the wrong person. Requiring a lead per
 * code is what stops a new Worker code inheriting a sentence that is false
 * about it.
 *
 * @since 1.0.0
 * @category models
 */
export interface WorkerRefusalCopyRow {
  /** The line above the Worker's own words. Written for every code; never inherited. */
  readonly lead: string
  /** The sentence handed to the chat model, when the fault's own is not specific enough. */
  readonly agent?: string
  /** The ways out, when they differ from the fault's. */
  readonly doors?: ReadonlyArray<RefusalDoor>
}

/**
 * The copy for every code the Cloudflare Worker refuses with.
 *
 * `satisfies Record<WorkerFailureCode, WorkerRefusalCopyRow>` is the gate: a
 * code added to WorkerFailureCodes.ts with no row here does not compile, so no
 * Worker refusal can reach a person with a sentence nobody wrote for it.
 *
 * @since 1.0.0
 * @category constants
 */
export const WORKER_REFUSAL_COPY = {
  client_disconnected: { lead: "That request stopped before it finished — the page went away.", doors: ["retry"] },
  cloud_token_unavailable: {
    lead: "Smithers couldn't get a Cloud token for your account, so it never got as far as asking.",
    doors: ["retry"]
  },
  cross_origin_blocked: { lead: "Smithers only answers this from its own page.", doors: [] },
  /*
   * The refusal this whole file was extended for. It is `infra`, like a full
   * fleet, and it must NOT read like one: "we ran out" tells a reader that
   * somebody should buy more, when in fact a value on this deployment was
   * never set and buying more of anything changes nothing. The audience is
   * whoever deployed it, which is the part the sentence has to carry.
   */
  deployment_not_configured: {
    lead:
      "This deployment of Smithers isn't fully set up. Not your fault — and not something you can fix from here; whoever deployed it has to finish wiring it.",
    agent:
      "fault=infra: this DEPLOYMENT is missing configuration a seam needs — an unset secret, a missing binding, an upstream nobody filled in. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Say plainly that this deployment is misconfigured and that it takes whoever deployed it to fix. Do not retry it and do not suggest they change what they asked for.",
    doors: ["report"]
  },
  error_reports_throttled: {
    lead: "Smithers is already holding enough crash reports from here. Nothing you were doing is lost.",
    doors: []
  },
  feature_unavailable_here: { lead: "This build of Smithers doesn't do that.", doors: [] },
  gateway_proxy_removed: { lead: "That door was removed from Smithers.", doors: [] },
  method_not_allowed: { lead: "That address doesn't take that kind of request.", doors: [] },
  model_no_answer: {
    lead: "The model service took the turn and then said nothing at all. Nothing was charged.",
    doors: ["retry"]
  },
  model_rate_limited: {
    lead: "The model service is throttling this whole deployment — not your account. Nothing was charged.",
    agent:
      "fault=dependency: the model provider is rate-limiting THIS DEPLOYMENT, not the user's account and not their request. Nothing was charged. Say it is worth trying again shortly, and never suggest they change what they asked for.",
    doors: ["retry"]
  },
  procedure_not_relayed: { lead: "Smithers doesn't relay that call.", doors: [] },
  request_body_not_json: { lead: "Smithers couldn't read that request as JSON.", doors: ["retry"] },
  request_body_too_large: { lead: "That's more than this part of Smithers takes in one request.", doors: ["retry"] },
  request_body_unreadable: { lead: "That request ended before Smithers had all of it.", doors: ["retry"] },
  request_conflict: { lead: "That can't be done from the state things are in right now.", doors: ["retry"] },
  request_invalid: { lead: "Smithers can't do that as asked.", doors: ["retry"] },
  route_not_found: { lead: "There's nothing at that address.", doors: [] },
  /*
   * The other half of `deployment_not_configured`, at the status a seam that
   * is simply absent answers. Same audience, same "nothing is full", and the
   * same reason it must not borrow the capacity sentence.
   */
  seam_not_configured: {
    lead:
      "This deployment of Smithers doesn't have the piece that answers this. Not your fault — and not something you can switch on from here.",
    agent:
      "fault=infra: the seam this needs is ABSENT on this deployment (a local or stub stack, a preview without it). Not the user's fault and not their request's. Nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Say the deployment does not have this seam. Do not retry it.",
    doors: ["report"]
  },
  service_auth_required: {
    lead: "That door is for Smithers' own services, and the credential didn't match.",
    doors: []
  },
  service_temporarily_unavailable: {
    lead: "That part of Smithers couldn't answer just now. Not your fault.",
    agent:
      "fault=infra: one of Smithers' own seams is up but could not answer this request. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. It is worth asking again shortly; do not suggest they change what they asked for.",
    doors: ["retry"]
  },
  session_expired: {
    lead: "That session has expired. Anything you already finished is still saved.",
    doors: ["sign-in", "retry"]
  },
  /*
   * The third `infra` code that is neither a full fleet nor a misconfigured
   * deployment: an id the client already spent on other work. The person did
   * nothing wrong and nothing is broken, so the sentence spends the id out
   * loud and says the next attempt is a new request.
   */
  setup_request_conflict: {
    lead: "This setup request was already used for another operation. Not your fault; retry starts a new one.",
    agent:
      "fault=infra: the setup request id the app sent already names different work on Smithers' side — another candidate, operation or workspace. Not the user's fault and not their request's. Nothing is full, so do NOT say Smithers ran out of infra. The next attempt asks under a new request id, so say plainly that retrying is worth it.",
    doors: ["retry"]
  },
  sign_in_required: { lead: "Smithers Cloud doesn't recognise this session.", doors: ["sign-in"] },
  storage_failed: {
    lead: "Smithers' own storage failed on that. Not your fault, and nothing you asked for caused it.",
    agent:
      "fault=infra: Smithers' own Durable Object storage failed. Not the user's fault, not their request's, and not an upstream's, and nothing is full, so do NOT say Smithers ran out of infra and do NOT tell them to ask for more of it. Do not suggest they change what they asked for.",
    doors: ["retry", "report"]
  },
  tools_not_supported: { lead: "That part of Smithers answers in plain text and runs no tools.", doors: [] },
  trigger_approval_missing: { lead: "Smithers Cloud has no record of anyone approving that plan.", doors: ["retry"] },
  turn_already_running: { lead: "That turn is already running.", doors: [] },
  turn_not_yours: { lead: "That turn belongs to a different account.", doors: [] },
  turn_rate_limited: {
    lead: "That's the turn budget for now — nothing is broken, and nothing was charged.",
    agent:
      "fault=wait: a turn budget is spent — the user's own, or this deployment's shared anonymous one; the message says which. Nothing is broken and nothing was charged. Do not re-run the turn in a loop and do not tell them to change what they asked for.",
    doors: ["retry"]
  },
  unexpected_failure: { lead: "That's a bug in Smithers, not something you did.", doors: ["retry", "report"] },
  upstream_malformed: {
    lead: "Something Smithers depends on answered in a shape Smithers couldn't use.",
    doors: ["retry"]
  },
  upstream_refused: { lead: "Something Smithers depends on refused that. Not your doing.", doors: ["retry"] },
  upstream_timeout: { lead: "Something Smithers depends on didn't answer in time.", doors: ["retry"] },
  upstream_unreachable: { lead: "Smithers couldn't reach something it depends on.", doors: ["retry"] },
  /*
   * The other `infra` code that is not a full fleet. Nothing is exhausted and
   * nothing was misconfigured: the box this work was pinned to is gone, and
   * asking again gets a new one. So the sentence says what retrying does,
   * rather than sending the reader to whoever deployed Smithers.
   */
  workspace_gone: {
    lead: "The workspace behind this setup is gone. Not your fault; retry creates a new one.",
    agent:
      "fault=infra: the workspace this request was pinned to no longer exists on Smithers Cloud — deleted, or lost with its VM. Not the user's fault and not their request's. Nothing is full, so do NOT say Smithers ran out of infra. Repeating the same operation selects a new workspace, so say plainly that it is worth asking again.",
    doors: ["retry"]
  },
  /*
   * The state a resumed workspace spends its first minutes in, which for a
   * long time had no sentence of its own and borrowed `upstream_refused`'s.
   * That lead is the reason this row exists: "something refused that" sends a
   * reader looking for a broken dependency, when the only thing that happened
   * is that their box has not finished booting. Nothing refused, nothing is
   * full, nothing is wrong, and the wait is the whole story, so the sentence
   * is the wait.
   */
  workspace_starting: {
    lead: "It's still starting up. A workspace takes a minute or two to come up, and nothing refused anything.",
    agent:
      "fault=wait: the user's own workspace is BOOTING — resumed from a suspend, or just created. Nothing refused the request, nothing is broken, nothing is full and nobody is at a limit, so do NOT say an upstream refused it, do NOT say Smithers ran out of infra, and do NOT tell them to change what they asked for. Say their workspace is still coming up and that it is worth asking again in a moment.",
    doors: ["retry"]
  }
} satisfies Record<WorkerFailureCode, WorkerRefusalCopyRow>

/**
 * The copy that depends on WHO refused rather than on what the code was.
 *
 * Two of the four origins need it. A `client` refusal has no code at all — no
 * server issued one — so the fault's row is the only thing that would speak
 * for it, and the fault's row is about our fleet. A `local` refusal is the
 * desktop app's own host on 127.0.0.1 answering a route the Worker also
 * serves, under the same code and the same status; the only thing that
 * separates them is the noun in the sentence, and "this deployment" is wrong
 * for a program on the reader's own laptop.
 *
 * An entry names either a whole row (`client`, which has no code to key on) or
 * a per-code rewording (`local`). Neither `plue` nor `worker` needs one: their
 * code tables already say everything.
 *
 * @since 1.0.0
 * @category constants
 */
export const BY_ORIGIN: {
  readonly client: RefusalCopyRow
  readonly local: Partial<Record<WorkerFailureCode, WorkerRefusalCopyRow>>
} = {
  client: {
    lead: NOTHING_ANSWERED,
    agent:
      "fault=infra origin=client: the request never reached a server at all — a dead connection, DNS, TLS, or an aborted fetch. Nothing judged it, so it is not the user's fault and not their request's. Do NOT say Smithers ran out of infra and do NOT say anything is full: nothing answered, so nothing is known about our capacity either way. Say the request did not get through, that it looks like the connection, and that it is worth trying again.",
    /* Nothing to report to us: we were never reached, so there is nothing on our side to look at. */
    doors: ["retry"]
  },
  local: {
    /*
     * The desktop build has no deployment and nobody "deployed" it — the app
     * on the reader's machine is missing a piece of its own setup, and the
     * only person who can act is the reader.
     */
    deployment_not_configured: {
      lead:
        "This build of Smithers isn't fully set up. Not your fault — the app on this machine is missing a piece of its own configuration.",
      agent:
        "fault=infra origin=local: the desktop app's own host is missing configuration a seam needs. Not the user's fault and not their request's, and nothing is full, so do NOT say Smithers ran out of infra. This is the build on their machine, NOT a deployment and NOT a server — never tell them to contact whoever deployed it. Do not retry it."
    },
    seam_not_configured: {
      lead: "This build of Smithers doesn't carry the piece that answers this. Not your fault.",
      agent:
        "fault=infra origin=local: the seam this needs is absent from the desktop build on the user's machine. Not their fault and not their request's. Nothing is full, so do NOT say Smithers ran out of infra, and do not refer to a deployment or to whoever deployed it. Do not retry it."
    }
  }
}

/** The fault's row with a Worker code's written lead, and its overrides where it states them. */
const workerRow = (base: RefusalCopyRow, row: WorkerRefusalCopyRow): RefusalCopyRow => ({
  lead: row.lead,
  agent: row.agent ?? base.agent,
  doors: row.doors ?? base.doors
})

/** A Worker code's row, reworded when the native host — not a deployment — is the one refusing. */
const codeRow = (code: WorkerFailureCode, origin: RefusalOrigin): WorkerRefusalCopyRow => {
  const written = WORKER_REFUSAL_COPY[code]
  const local = origin === "local" ? BY_ORIGIN.local[code] : undefined
  return local === undefined ? written : { ...written, ...local }
}

/**
 * The copy for one refusal: its fault's row, with any per-code override applied.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalCopy = (refusal: Refusal): RefusalCopyRow => {
  /*
   * Nothing answered, so there is no code and no server's verdict — only the
   * one thing that is true of every such failure. The fault's row would speak
   * about our fleet, which is exactly what we cannot know here.
   */
  if (refusal.origin === "client") return BY_ORIGIN.client
  const base = REFUSAL_COPY[refusal.fault]
  /*
   * The native host's own codes take the FAULT'S row, the way plue's do and
   * unlike the Worker's. The Worker needs a written lead per code because two
   * of its codes are `infra` and only one of them is a full fleet; no native
   * code is `infra` at all (NativeFailureCodes.ts), so the fault's sentence is
   * true of every one of them and there is nothing for a per-code line to
   * disambiguate.
   */
  const row = refusal.code === null
    ? base
    : isWorkerFailureCode(refusal.code)
    ? workerRow(base, codeRow(refusal.code, refusal.origin))
    : isNativeFailureCode(refusal.code)
    ? base
    : ((override) => override === undefined ? base : { ...base, ...override })(BY_CODE[refusal.code])
  /*
   * A 409 that named no code at all. plue always codes its refusals now, so
   * this is an older deployment or the Worker's own envelope — and 409 on a
   * box act has one meaning, "not in a state that allows this", whose way out
   * has always been Resume. A CODED refusal never reaches this line: its row
   * above has already said what to offer, `desktop_not_running` included.
   */
  return refusal.code === null && refusal.status === 409 && !row.doors.includes("resume")
    ? { ...row, doors: [...row.doors, "resume"] }
    : row
}

/**
 * The line the interface puts above the refusing party's own words.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalLead = (refusal: Refusal): string => refusalCopy(refusal).lead

/**
 * Which ways out this surface should offer. A surface renders only the doors it has.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalDoors = (refusal: Refusal): ReadonlyArray<RefusalDoor> => refusalCopy(refusal).doors

const LOCAL_SUFFIX = "@local"

/**
 * The one sentence a seam hands back for a refusal — the line a person reads
 * in the transcript or a toast.
 *
 * Its shape is `<code> — <the refusing party's own words>. <lead>`, with
 * `<code>@local` for a Worker code the desktop host wrote: the code
 * first, which is the convention the workspace seam already used and which is
 * also the anchor `agentFaultNote` reads; then plue's words, untouched; then
 * the one line that says whose fault it was. A person who never opens the card
 * still gets told that a full fleet is not their doing.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalSentence = (refusal: Refusal): string => {
  const words = refusal.message.trim()
  const stopped = words === "" || /[.!?]$/u.test(words) ? words : `${words}.`
  /*
   * A Worker code the desktop host wrote says so in the token: the code alone
   * reads as the Worker's, and `agentFaultNote` would then tell the model that
   * "this deployment" failed when it was a program on the reader's laptop.
   */
  const local = refusal.origin === "local" && isWorkerFailureCode(refusal.code) ? LOCAL_SUFFIX : ""
  const head = refusal.rawCode === null ? "" : `${refusal.rawCode}${local} — `
  return stopped === "" ? `${head}${refusalCopy(refusal).lead}` : `${head}${stopped} ${refusalCopy(refusal).lead}`
}

const stopped = (text: string): string => /[.!?]$/u.test(text) ? text : `${text}.`

/**
 * The one line a person reads for a refusal, with no code and no raw text.
 *
 * The refusing party's own words lead only when the person can act on them:
 * a `user`-fault refusal that plue, or an upstream naming no code, wrote.
 * Everything else (another fault, a Worker or desktop-host code, nothing
 * answering) is `context`, the caller's own words for what failed, followed by
 * the written lead for its code or fault. A server's words for a failure that
 * is not the reader's (a stack, a driver message, a 5xx body) never reach
 * them; they stay on the refusal for diagnostics and the model.
 *
 * @since 1.0.0
 * @category constants
 */
export const refusalLine = (refusal: Refusal, context: string): string => {
  const words = refusal.message.trim()
  const theirs = refusal.fault === "user" && refusal.origin !== "client" && refusal.origin !== "local" &&
    !isWorkerFailureCode(refusal.code) && !isNativeFailureCode(refusal.code)
  if (theirs && words !== "") return words
  const lead = refusalCopy(refusal).lead
  const said = context.trim()
  return said === "" ? lead : `${stopped(said)} ${lead}`
}

/*
 * A code as `refusalSentence` writes it, at the front of the string and
 * nowhere else. Anchored on purpose: several of plue's codes (`conflict`,
 * `internal`, `not_found`) are ordinary English words, and a scan for them
 * anywhere in a sentence would be the prose-matching this whole file exists
 * to remove.
 */
const LEADING_CODE = /^([A-Za-z][A-Za-z0-9_]*)(@local)? — /u

/**
 * The fault the model should be told, for a refusal that reached the agent
 * boundary as a STRING rather than as an object.
 *
 * A seam's refusal travels through the flow harness as one string: the
 * harness classifies a call with `CallResult.code`, but a seam's own verdict
 * is not in that closed set, so it rides in the text. The verdict is therefore
 * recovered from the one machine token the app itself put at the front of that
 * message, looked up in the two closed registries — never inferred from the
 * English around it. A string with no code in that position gets no note, and
 * the model is left with the sentence rather than a guess dressed as a fact.
 *
 * All three vocabularies are read: a Worker refusal ("this deployment is not
 * configured") and a native-host one ("no Node on this box") reach the model
 * through exactly the same string channel as a plue one, and used to arrive
 * with no verdict at all.
 *
 * @since 1.0.0
 * @category constants
 */
export const agentFaultNote = (text: string): string | null => {
  const refusal = leadingRefusal(text)
  return refusal === null ? null : `[fault=${refusal.fault} code=${refusal.code}] ${refusalCopy(refusal).agent}`
}

/**
 * The refusal a string's leading code names — `<code> — …` or
 * `<code>@local — …`, as `refusalSentence` writes it — rebuilt from the closed
 * registries with no message, so its lead is the written sentence and never
 * the words after the code. Null when no known code leads.
 *
 * @since 1.0.0
 * @category constants
 */
export const leadingRefusal = (text: string): Refusal | null => {
  const leading = LEADING_CODE.exec(text)
  const code = refusalCode(leading?.[1])
  const entry = refusalEntry(code)
  if (code === null || entry === null) return null
  return {
    code,
    rawCode: code,
    fault: entry.fault,
    message: "",
    retryAfter: entry.retryAfter === 0 ? null : entry.retryAfter,
    status: entry.status,
    origin: isNativeFailureCode(code) || leading?.[2] === LOCAL_SUFFIX
      ? "local"
      : isWorkerFailureCode(code)
      ? "worker"
      : "plue"
  }
}

/**
 * The tool result the chat model is handed.
 *
 * The machine facts come first, bracketed, so the model is TOLD the fault class
 * rather than inferring it — a client fetch that threw used to arrive as
 * `failed: Load failed`, and the model read that as the user's mistake. The
 * refusing party's own words follow, then the sentence for this fault. The
 * `failed:` prefix is load-bearing: the turn controller's act line keys off it.
 *
 * @since 1.0.0
 * @category constants
 */
export const agentRefusalText = (refusal: Refusal): string => {
  const facts = [
    `fault=${refusal.fault}`,
    ...(refusal.rawCode === null ? [] : [`code=${refusal.rawCode}`]),
    ...(refusal.status === null ? [] : [`status=${refusal.status}`]),
    ...(refusal.retryAfter === null ? [] : [`retry_after=${refusal.retryAfter}s`]),
    `origin=${refusal.origin}`
  ].join(" ")
  return `failed: [${facts}] ${refusal.message} — ${refusalCopy(refusal).agent}`
}

const USER_ACTIONS: ReadonlySet<string> = new Set(USER_FAILURE_ACTIONS)

/**
 * A refusal as a `UserFailure`, for a surface that renders failures through
 * the one presenter: the lead is the sentence, the doors that are also user
 * failure actions are the actions, and the code with the refusing party's own
 * words is the detail a surface keeps behind Details. Doors with no action
 * (`upgrade`, `resume`, `new-box`, `report`) stay the surface's to draw.
 *
 * @since 1.0.0
 * @category constructors
 */
export const refusalUserFailure = (refusal: Refusal): UserFailure => {
  const copy = refusalCopy(refusal)
  const words = refusal.message.trim()
  return {
    tag: refusal.rawCode,
    fault: refusal.fault,
    sentence: copy.lead,
    actions: copy.doors.filter((door): door is RefusalDoor & UserFailureAction => USER_ACTIONS.has(door)),
    detail: refusal.rawCode === null ? words : words === "" ? refusal.rawCode : `${refusal.rawCode} — ${words}`
  }
}
