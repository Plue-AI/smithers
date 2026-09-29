/**
 * The sentence a failed run's stamped fault reads as.
 *
 * A failed run journals `{ class, tag }` beside its cause
 * (`@smthrs/flow/Fault`), and the gateway carries it on the run row as
 * `failureFault` and `failureTag`. `tag` is `<_tag>/<code>`, so it names the
 * error's author: a code another vocabulary also spells can no longer be
 * mistaken for the model's, and blame is never read off a code string. The
 * class comes from the stamp; this table only words the harness's and the
 * model's codes, and a tag without a row reads as its class's lead.
 *
 * @see ../../../../../packages/smithers/flows/flow/src/Fault.ts
 */
import type { HarnessErrorCode } from "@smthrs/harness/HarnessError"
import type { ModelErrorCode } from "@smthrs/model/ModelError"

const HARNESS_COPY = {
  assembly_failed: "This run couldn't be assembled, so no turn ever opened. Not your fault — that's a defect here.",
  incompatible_journal: "This run's record was written by a different version of Smithers and can't be read back. Not your fault — start a new run.",
  render_failed: "Smithers couldn't build the next turn to send. Not your fault, and not your request's — that's a defect here.",
  model_failed: "A turn opened and the model never answered, so the run stopped with no result. Not your fault — the turns it finished stand, and it's worth asking again.",
  engine_failed: "The engine underneath this run failed before a turn could finish, so the run stopped. Not your fault, and the turns it finished stand; it's worth starting it again.",
  read_only_cap: "This run read for turn after turn without changing anything, so Smithers stopped it. Not your fault — it's worth asking again.",
  completion_unjudged: "The run finished, but nothing was able to check its answer, so Smithers didn't pass it on. Not your fault — it's worth asking again.",
  claim_unproven: "The run claimed work its own record doesn't show it doing, so Smithers refused the answer rather than pass it on. Not your fault — ask again and it has to show the work.",
  suspended: "The run stopped to wait for something that never came. Not your fault — it's worth starting it again."
} as const satisfies Record<HarnessErrorCode, string>

const MODEL_COPY: Partial<Record<ModelErrorCode, string>> = {
  context_overflow: "The conversation outgrew the model's context window. Not your fault — start a fresh run.",
  no_route: "No model seat was available for this run. Not your fault — it's a setting on Smithers' side.",
  authentication: "The model provider rejected the sign-in. Sign in again, then run it again.",
  quota_exceeded: "The model account is out of credit, so the run stopped where it was. Not your fault — it can run again once the account has credit.",
  out_of_credit: "The hosted credit is spent, so the run stopped where it was. Add credit, then run it again.",
  content_policy: "The model provider refused this request under its content policy. Ask for something else.",
  provider_internal: "The model provider failed on its own side. Not your doing — it's worth asking again.",
  transport: "The call to the model provider never completed. Not your doing — it's worth asking again.",
  call_timeout: "A model call ran past the time this run allows and was cut off, so nothing came back from it. Not your fault — asking for something shorter usually gets through.",
  invalid_provider_output: "The model provider answered with something Smithers couldn't read. Not your doing — it's worth asking again."
}

/**
 * The sentence for a stamped fault tag, or `undefined` when the tag names no
 * worded harness or model code.
 *
 * @category conversions
 */
export const runCause = (tag: string): string | undefined => {
  const [author, code] = [tag.slice(0, tag.lastIndexOf("/")), tag.slice(tag.lastIndexOf("/") + 1)]
  const table: Readonly<Record<string, string>> = author === "/harness/HarnessError" ? HARNESS_COPY
    : author === "flows/model/ModelError" ? MODEL_COPY
    : {}
  return Object.hasOwn(table, code) ? table[code] : undefined
}
