import { gatewayBindingFor, resolveTargetRepo } from "../RepoContext"
import { flowArgs } from "../../flows/FlowArgs"
import type { ControllerContext } from "./context"
import { isFlowNotFound } from "./gateway"
import type { WorkflowController } from "./workflows"

export type Answer = Promise<string | void | { readonly value: string }>
export interface OnboardingController {
  readonly prototypeFeature: (request: string, repo?: string) => Answer
}
export const PROTOTYPE_FLOW_ID = "prototype"
export const PROTOTYPE_RUN_KIND = "prototype"

export interface OnboardingDependencies {
  /** The requirement axis' durable park (AppController.deferCommand). */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  /** The sign-in step, rendered into the chat (auth.prompt). */
  readonly promptSignIn: (required?: boolean, request?: { readonly name: string; readonly args?: string | null }) => void
  /** The one launch path (flow.run's): guards, the workspace, the launch, the run card. */
  readonly workflows: Pick<
    WorkflowController,
    "workflowIdentityGuard" | "workflowBalanceGuard" | "provisionWorkspace" | "launchWorkflow" | "requireBox"
  >
}

export const createOnboardingController = (ctx: ControllerContext, deps: OnboardingDependencies): OnboardingController => {
  const { store } = ctx

  /**
   * The definitive signed-out answer gates; unknown or unavailable identity
   * never blocks (the seam discipline: gate on answers, not on silence).
   * Answers the refusal to hand back, or undefined when the flow may run.
   */
  const gate = (flow: string, explicit: string | undefined): string | void => {
    if (!ctx.commands.state().signedOut) return
    if (ctx.commandActor === "user") deps.deferCommand(flow, explicit ?? null, "signed-in")
    deps.promptSignIn(false, { name: flow, args: explicit })
    return ctx.commandActor === "user"
      ? undefined
      : "Sign in with GitHub first. The sign-in step is already rendered in the chat; point the user at it."
  }

  /*
   * A run of kind prototype on the request. The sign-in gate parks a
   * signed-out human on the auth.prompt step (resumed after the redirect) and
   * refuses the model; after it, the guards are the ones flow.run applies:
   * the allowlist and the balance. The launch is flow.run's own (provision,
   * then Plan, approve, Run through the gateway seam), and the card it
   * upserts carries the kind, so the run renders as a trace with the
   * never-promoted banner rather than as a second surface.
   *
   * No `prototype` flow ships yet, so the honest answer today is a refusal
   * naming the flow the workspace lacks, never a fake run. The workspace is
   * the only authority on which flows it has (`.smithers/factory.json` lists
   * rules, not flows, and the flow list is a gateway read), so the check
   * comes after provisioning and before anything is planned or approved: the
   * flow.list seam answers first, and a launch the workspace still refuses
   * with ControlError.FlowNotFound (which carries no message) is read off
   * that error's code, never off its prose.
   */
  const prototypeFeature: OnboardingController["prototypeFeature"] = async (request, explicit) => {
    const what = request.trim()
    if (what === "") return "feature.prototype needs what the feature should do"
    const gated = gate("feature.prototype", explicit === undefined ? what : `${what} ${explicit}`)
    if (gated !== undefined || ctx.commands.state().signedOut) return gated
    const guard = deps.workflows.workflowIdentityGuard()
    if (guard !== undefined) return guard
    const balance = deps.workflows.workflowBalanceGuard()
    if (balance !== undefined) return balance
    const target = resolveTargetRepo(store, explicit)
    if ("error" in target) return target.error
    const { repo } = target
    // No box, no run: a human gets the box form; the agent keeps the refusal.
    const prerequisite = deps.workflows.requireBox(repo, { flow: "feature.prototype", args: flowArgs("feature.prototype", { request: what, repo }) },
      `Open a box to prototype a feature in ${repo}`)
    if (prerequisite !== undefined) return prerequisite
    const binding = gatewayBindingFor(store, repo)
    if ("error" in binding) return binding.error
    const provisioned = await deps.workflows.provisionWorkspace(repo, binding)
    if (provisioned !== true) return provisioned
    const missing = `${repo} has no ${PROTOTYPE_FLOW_ID} flow on its workspace yet, so there is nothing to run the prototype with.`
    const flows = await ctx.gateway.listFlows(repo, binding)
    if (flows.status === "ok" && !flows.value.some((flow) => flow.flowId === PROTOTYPE_FLOW_ID)) return missing
    const launched = await deps.workflows.launchWorkflow({
      repo,
      workflow: PROTOTYPE_FLOW_ID,
      input: { goal: what },
      binding,
      title: `${PROTOTYPE_RUN_KIND} · ${what.length > 80 ? `${what.slice(0, 79)}…` : what}`,
      kind: PROTOTYPE_RUN_KIND
    })
    // A workspace without the prototype flow says so; the refusal names the flow, never a guess at another.
    if ("message" in launched) return isFlowNotFound(launched.code) ? missing : launched.message
    // The same minimal acknowledgment flow.run answers: the card is the claim surface.
    return { value: `run-started workflow=${PROTOTYPE_FLOW_ID} run=${launched.runId} repo=${repo} kind=${PROTOTYPE_RUN_KIND}` }
  }

  return { prototypeFeature }
}
