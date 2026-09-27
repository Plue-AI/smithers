/*
 * Wave 12 — result claims are deterministic, and the last first-run polish.
 *
 * §1 is the load-bearing one: wave 11 pinned the tool result and the system
 * prompt, and the deployed model still wrote "The workflow
 * "summarize-open-issues" has been created and is now running" beside a card
 * truthfully reading Running. These tests assert the RENDERED turn, not the
 * model's intent — the exact wave-11 transcript is replayed through the real
 * controller and the lie must not be on screen.
 *
 * §2 (which loaded repository), §3 (a run the workspace never finishes) and
 * §4 (the residuals) are pinned the same way: through the real controller,
 * against a relay double speaking the shapes the receipts recorded.
 */
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { claimsRunState, renderedRunTurnText, runLaunchCommandOf, toolResultLaunchedRun } from "./RunClaims"
import { json, loadBox, memoryStorage, scriptedToolAgent, settle, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

/** Wait for a condition rather than a fixed sleep — a loaded machine still passes. */
const REPO = "codeplanesmithers/smithers-demo"
const OTHER_REPO = "codeplanesmithers/smithers-cloud"

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** The durable card `flow.create` mints: where a background refusal is stated and retried. */
const authoringCard = (store: Awaited<ReturnType<typeof webStore>>) => {
  const card = [...store.collections.cards.values()].find((entry) => entry.kind === "run-trace" && entry.payload.authoring !== undefined)
  return card?.kind === "run-trace" ? card : undefined
}

/** The same relay double wave 11 proved against, with the states §3/§4 need. */
const relay = (options: {
  readonly provision?: () => unknown
  readonly provisionStatus?: number
  readonly flows?: ReadonlyArray<{ flowId: string }>
  readonly cancelFails?: boolean
} = {}) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const state = {
    runStatus: "running" as string,
    revision: 1,
    turns: 0,
    calls: 0,
    launched: [] as Array<{ workflow: string; input: unknown; repo: string }>
  }
  const flows = options.flows ?? [{ flowId: "create-flow" }, { flowId: "review-pr" }]
  let planned: { flowId: string; input: unknown } | undefined

  const procedure = (repo: string, name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List":
        return json(200, {
          ok: true,
          payload: { _tag: "flows", items: flows.map((flow) => ({ flowId: flow.flowId, description: "" })) }
        })
      case "Plan": {
        const flowId = String(payload.flowId)
        if (!flows.some((entry) => entry.flowId === flowId)) {
          return json(200, { ok: false, error: { message: `Unknown workflow: ${flowId}` } })
        }
        planned = { flowId, input: payload.input }
        return json(200, {
          ok: true,
          payload: {
            planId: `plan-${flowId}`,
            flowId,
            digest: "digest-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            inputSummary: "",
            deployClass: false,
            nodes: []
          }
        })
      }
      case "Run":
        state.launched.push({ workflow: planned?.flowId ?? "?", input: planned?.input, repo })
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: "run-w12" } })
      case "Cancel":
        if (options.cancelFails === true) return json(200, { ok: false, error: { message: "Cancel failed." } })
        state.runStatus = "cancelled"
        state.revision += 1
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "c", runId: "run-w12" } })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "approvals") {
          return json(200, { ok: true, payload: { cursor: { projection: "approvals", runId: null, value: 0 }, rows: [] } })
        }
        return json(200, {
          ok: true,
          payload: {
            cursor: { projection: "run-summary", runId: "run-w12", value: state.revision },
            rows: [{
              runId: "run-w12",
              flowId: state.launched.at(-1)?.workflow ?? "review-pr",
              status: state.runStatus,
              createdAt: 1,
              updatedAt: 1 + state.revision + state.turns + state.calls,
              turns: state.turns,
              calls: state.calls,
              callsFailed: 0,
              editsAttempted: 0,
              editsSucceeded: 0,
              inputTokens: 0,
              outputTokens: 0,
              verdict: state.runStatus === "completed" ? "completed — done." : state.runStatus,
              diagnosis: "Verdict   done."
            }]
          }
        })
      }
      default:
        return json(200, { ok: false, error: { message: `no ${name}` } })
    }
  }

  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ path: absolute.pathname + absolute.search, method: init?.method ?? "GET", body })
      if (absolute.pathname === "/api/workflow/provision") {
        return json(options.provisionStatus ?? 200, options.provision?.() ?? { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      }
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.repo), String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }

  return {
    services,
    calls,
    state,
    /** The run did some work: the summary's counters move. */
    advance: (turns: number, callCount: number) => {
      state.turns += turns
      state.calls += callCount
    }
  }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>, loaded: string[] = [REPO]) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: loaded.map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  for (const [index, fullName] of loaded.entries()) await loadBox(store, fullName, `0b0c0d0e-0000-4000-8000-00000000000${index + 1}`)
  await settle(2)
}

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  const card = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.runId === "run-w12")
  return card?.kind === "run-trace" ? card : undefined
}

/** The whole rendered turn, as the transcript holds it. */
const transcript = (store: Awaited<ReturnType<typeof webStore>>): string =>
  [...store.collections.messages.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => message.text)
    .join("\n")

/** The exact frames the canary turn produced, replayed. */
const WAVE11_LIE =
  "The workflow \"summarize-open-issues\" has been created and is now running on codeplanesmithers/smithers-demo."

describe("wave 12 §1 — the model may not narrate run state", () => {
  test("the wave-11 transcript replayed: the rendered turn contains no 'has been created'", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({
            action: "execute",
            name: "flow.create",
            args: "a workflow that summarizes my open issues"
          })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: WAVE11_LIE },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("can you make me a smithers workflow that summarizes my open issues?")
    await settle(30)

    const rendered = transcript(store)
    // The lie is not on screen, in whole or in part.
    expect(rendered).not.toContain("has been created")
    expect(rendered).not.toContain("summarize-open-issues")
    // What IS on screen: the deterministic line, and the card beside it.
    expect(rendered).toContain("Run requested.")
    expect(runCard(store)).toBeDefined()
    // The act line names the run the CLIENT started, from the machine ack.
    expect(rendered).toContain(`Smithers requested a create-flow run on ${REPO}`)
  })

  test("prose that claims nothing about the run is rendered untouched", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        {
          type: "delta" as const,
          kind: "text" as const,
          text: "Approvals go to you, never to me."
        },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    expect(transcript(store)).toContain("Approvals go to you, never to me.")
  })

  test("a slash-prefixed launch arms the gate exactly like the bare spelling", async () => {
    // ui-state-store/api-design/1: the tool schema accepts the catalog's
    // "/flow.create"; execution launched from it while the classifier read
    // the raw name and left the claim gate unarmed, so the lie rendered.
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: " /flow.create ", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: WAVE11_LIE },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    const rendered = transcript(store)
    expect(rendered).not.toContain("has been created")
    expect(rendered).toContain("Run requested.")
    expect(rendered).toContain(`Smithers requested a create-flow run on ${REPO}`)
    expect(runCard(store)).toBeDefined()
  })

  test("a preamble before the tool call is covered too — half a suppressed claim is still a claim", async () => {
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Creating that workflow for you now. " },
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [{ type: "done" as const, reason: "stop" as const }]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await settle(30)
    expect(transcript(store)).not.toContain("Creating that workflow for you now")
    expect(transcript(store)).toContain("Run requested.")
  })

  test("an unknown remote flow is requested, then its recorded refusal appears on the card", async () => {
    // The command records intent before the remote registry can refuse it.
    // Model prose cannot turn that receipt into an execution verdict.
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.run", args: "nope" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        {
          type: "delta" as const,
          kind: "text" as const,
          text: "There's no workflow called nope — nothing was started."
        },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("run nope")
    await settle(30)
    expect(transcript(store)).toContain("Smithers requested a nope run")
    expect(transcript(store)).toContain("Run requested.")
    expect(transcript(store)).not.toContain("Smithers started")
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.payload.error === "Unknown workflow: nope"))
  })

  test("held-back whitespace still settles the turn — the composer never locks (review)", async () => {
    /*
     * Review pass: after a launch the model's text is BUFFERED, so a
     * continuation of nothing but whitespace left no answer message behind.
     * `message.response.completed` no-ops when that message is missing, so the
     * session's phase stayed `responding` forever and `send` refused every
     * later submit — a launch could brick the chat. The turn must settle, and
     * the honest report is the empty-response one that already exists.
     */
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      () => [
        { type: "delta" as const, kind: "text" as const, text: "   \n " },
        { type: "done" as const, reason: "stop" as const }
      ]
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await waitFor(() => store.session().phase === "idle")
    expect(store.session().phase).toBe("idle")
    // The launch itself still happened and is stated by the client.
    expect(transcript(store)).toContain("Smithers requested a create-flow run")
  })

  test("a turn stopped mid-flight does not leave a claiming preamble standing (review)", async () => {
    /*
     * Review pass: the substitution only ran on the natural settle. A preamble
     * streamed BEFORE the tool call is already on screen, and stopping the turn
     * (or a leg that never starts) left it there — "Creating that workflow for
     * you now" surviving a stop is the wave-11 lie with a different ending.
     */
    const store = await webStore()
    const double = relay()
    const { agent } = scriptedToolAgent([
      () => [
        { type: "delta" as const, kind: "text" as const, text: "Your workflow has been created. " },
        {
          type: "tool_call" as const,
          call_id: "call_1",
          name: "commands",
          arguments: JSON.stringify({ action: "execute", name: "flow.create", args: "summarize my issues" })
        },
        { type: "done" as const, reason: "tool_call" as const }
      ],
      // The continuation leg never answers: the human stops the turn instead.
      () => []
    ])
    const controller = createAppController(store, agent, double.services)
    await signIn(store)

    controller.send("make me a workflow")
    await waitFor(() => runCard(store) !== undefined)
    controller.stop()
    await settle(4)

    expect(transcript(store)).not.toContain("has been created")
    expect(transcript(store)).toContain("Run requested.")
    expect(store.session().phase).toBe("idle")
  })

  test("the detector, in isolation: the live lie is a claim; a launch ack arms it", () => {
    expect(claimsRunState(WAVE11_LIE)).toBe(true)
    expect(claimsRunState("The workflow is ready for you.")).toBe(true)
    expect(claimsRunState("It should be done shortly.")).toBe(true)
    expect(claimsRunState("Approvals go to you, never to me.")).toBe(false)
    expect(renderedRunTurnText("flow.create", WAVE11_LIE)).toBe(
      "Run requested."
    )
    expect(
      runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "flow.create", args: "x" }))
    ).toBe("flow.create")
    expect(
      runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "/flow.create", args: "x" }))
    ).toBe("flow.create")
    expect(runLaunchCommandOf("commands", JSON.stringify({ action: "execute", name: "world" }))).toBeUndefined()
    expect(runLaunchCommandOf("commands", "not json")).toBeUndefined()
    expect(toolResultLaunchedRun("run-started workflow=create-flow run=r1 repo=o/r")).toBe(true)
    expect(toolResultLaunchedRun("failed: run-started")).toBe(false)
  })
})

describe("wave 12 §2 — flow.create asks WHICH loaded repo", () => {
  test("one loaded repo is not a question", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store, [REPO])

    const outcome = await controller.commands.run("flow.create", "summarize my issues")
    /* The door SAVES the request and answers; the launch rides the background (AGENTS.md instant chat). */
    expect(said(outcome)).toContain(`flow-requested repo=${REPO}`)
    expect(store.collections.cards.get("workflow-repo")).toBeUndefined()
    await waitFor(() => double.state.launched.length > 0)
    expect(double.state.launched[0]?.repo).toBe(REPO)
  })

  test("an owner/repo argument targets it directly — slash and agent alike", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store, [REPO, OTHER_REPO])

    const outcome = await controller.commands.run("flow.create", `summarize my open issues ${OTHER_REPO}`)
    expect(said(outcome)).toContain(`repo=${OTHER_REPO}`)
    // The repo token is the target, NOT part of the description.
    await waitFor(() => double.state.launched.length > 0)
    expect(double.state.launched[0]).toMatchObject({
      workflow: "create-flow",
      repo: OTHER_REPO,
      input: { args: "summarize my open issues" }
    })
    expect(store.collections.cards.get("workflow-repo")).toBeUndefined()
  })

  test("more than one loaded repo and no argument: the chooser-among-loaded, then one act creates it", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store, [REPO, OTHER_REPO])

    const asked = await controller.commands.run("flow.create", "summarize my open issues")
    expect(said(asked)).toContain("2 repositories")
    /*
     * Review pass: a QUESTION is not a failure. Live on canary the transcript
     * read "Smithers tried /flow.create — failed: You have 3
     * repositories…" beside the card that had just asked, correctly, which one.
     */
    expect(asked.status).toBe("executed")
    // EMBED LAW: the question is a card in the transcript, the surface stays.
    const card = store.collections.cards.get("workflow-repo")
    expect(card?.kind).toBe("workflow-repo")
    expect(card?.kind === "workflow-repo" && [...card.payload.repos].sort()).toEqual([OTHER_REPO, REPO].sort())
    expect(store.collections.sessions.get("main")?.surface).toBe("chat")
    // Nothing was provisioned on a guess.
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)

    // ONE confirm: choosing IS the answer, and the create resumes with it.
    const chosen = await controller.commands.run("flow.repo.choose", OTHER_REPO)
    expect(said(chosen)).toContain(`repo=${OTHER_REPO}`)
    await waitFor(() => double.state.launched.length > 0)
    expect(double.state.launched[0]).toMatchObject({
      repo: OTHER_REPO,
      input: { args: "summarize my open issues" }
    })
    const answered = store.collections.cards.get("workflow-repo")
    expect(answered?.kind === "workflow-repo" && answered.payload.chosen).toBe(OTHER_REPO)
    expect(answered?.status).toBe("acted")

    // Review pass: a question is answered ONCE. A second act on the same card
    // (two clicks racing the state) may not launch the same workflow twice —
    // a launch is real work on the user's workspace.
    const again = await controller.commands.run("flow.repo.choose", OTHER_REPO)
    expect(said(again)).toContain("already answered")
    expect(double.state.launched).toHaveLength(1)
  })

  test("the model may not answer the human's question for them (review)", async () => {
    /*
     * Review pass: the card bindings were `hidden` but not `trigger:
     * "user"`, and hidden only keeps a command out of the tool CATALOG — the
     * commands tool executes anything by name that is not user-only. So the
     * model could have picked the repository itself, provisioning on ITS guess
     * against the very thing §2 exists for (wave 10 §2a: a deterministic
     * affordance must not route through the model). The trigger axis is what
     * makes that structural.
     *
     * Lane runs changed flow.run.stop's stance deliberately: stopping a run
     * is consequential rather than browser mechanics, so the model may ASK
     * (confirm turns its invocation into a confirmation message; nothing runs
     * until the human clicks). The three-door law (agent-parity.md) moved
     * flow.run.retry to the same stance — a retry spends, so it confirms —
     * while flow.repo.choose stays user-only: it is the human's ANSWER.
     */
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store, [REPO, OTHER_REPO])

    await controller.commands.run("flow.create", "summarize my open issues")
    expect(store.collections.cards.get("workflow-repo")).toBeDefined()

    const refused = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.repo.choose", args: OTHER_REPO })
    })
    expect(refused).toContain("user-only")
    expect(refused).toContain("the human's choice")
    const retryAsked = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.run.retry", args: OTHER_REPO })
    })
    expect(retryAsked).toContain("asked the user to confirm")
    // A stop the model asks for is a question, never an act: nothing was cancelled.
    const asked = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "execute", name: "flow.run.stop", args: "flow-run-run-1" })
    })
    expect(asked).toContain("confirm")
    expect(double.calls.some((call) => JSON.stringify(call.body).includes("\"Cancel\""))).toBe(false)
    // The question is still open and nothing was provisioned on the model's say-so.
    const card = store.collections.cards.get("workflow-repo")
    expect(card?.kind === "workflow-repo" && card.payload.chosen).toBeNull()
    expect(double.calls.some((call) => call.path === "/api/workflow/provision")).toBe(false)
    // The catalog never listed them either.
    const listed = await controller.commands.executeForAgent({
      name: "commands",
      arguments: JSON.stringify({ action: "list" })
    })
    expect(listed).not.toContain("flow.repo.choose")
    expect(listed).not.toContain("flow.run.stop")
  })
})

describe("wave 12 §3 — a run the workspace never finishes", () => {
  test("no progress for the bound: the card says it has gone quiet and the pump stops", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      // A bound the test can actually wait out; production is 10 minutes.
      workflowQuietMs: 25
    })
    await signIn(store)

    // The live shape exactly: the run keeps reading "running" and its
    // summary never says another word.
    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")

    const card = runCard(store)
    expect(card?.payload.phase).toBe("quiet")
    expect(card?.payload.quietForMs).toBeGreaterThanOrEqual(25)

    // The pump stopped hammering: no further reads after it settled.
    const before = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    await settle(30)
    const after = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    expect(after).toBe(before)
  })

  test("real progress keeps the clock honest — a moving run never goes quiet", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      // Generous next to the emit cadence below: what is being pinned is
      // that progress RESETS the clock, not a race against the wall.
      workflowQuietMs: 1_000
    })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    for (let step = 1; step <= 5; step += 1) {
      double.advance(1, 1)
      await settle(10)
    }
    expect(runCard(store)?.payload.phase).toBe("running")
  })

  test("the quiet card's two acts are registered commands: check again, or stop watching", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, {
      ...double.services,
      workflowQuietMs: 25
    })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")

    // Retry restarts the watch and says so in words.
    expect((await controller.commands.run("flow.run.retry", runCard(store)!.id)).status).toBe("executed")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Checking the run again")
    await settle(4)

    /*
     * Stop now stops the RUN: the rc.0 gateway relays a durable `Cancel`, so
     * the card can say the run was cancelled without claiming anything the
     * workspace did not do.
     */
    expect((await controller.commands.run("flow.run.stop", runCard(store)!.id)).status).toBe("executed")
    await waitFor(() => runCard(store)?.payload.phase === "cancelled")
    expect(runCard(store)?.payload.steps.join(" ")).toContain("Cancelled this run.")
    expect(
      double.calls.some((call) => (call.body as { procedure?: string } | undefined)?.procedure === "Cancel")
    ).toBe(true)
    const settledCalls = double.calls.filter((call) => call.path === "/api/workflow/rpc").length
    await settle(30)
    expect(double.calls.filter((call) => call.path === "/api/workflow/rpc").length).toBe(settledCalls)
  })
})

describe("reopening a run whose watch went quiet or stopped re-reads its history, like Retry", () => {
  const historyReads = (double: ReturnType<typeof relay>) => double.calls.filter((call) =>
    (call.body as { payload?: { selector?: { _tag?: string } } } | undefined)?.payload?.selector?._tag === "run-events").length

  test("a quiet run", async () => {
    const store = await webStore()
    const double = relay()
    const controller = createAppController(store, silentAgent, { ...double.services, workflowQuietMs: 25 })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")
    const before = historyReads(double)

    expect((await controller.commands.run("runs.open", "run-w12")).status).toBe("executed")
    await waitFor(() => historyReads(double) > before)
  })

  test("a run whose Stop request failed", async () => {
    const store = await webStore()
    const double = relay({ cancelFails: true })
    const controller = createAppController(store, silentAgent, { ...double.services, workflowQuietMs: 25 })
    await signIn(store)

    await controller.commands.run("flow.run", "review-pr")
    await waitFor(() => runCard(store)?.payload.phase === "quiet")
    await controller.commands.run("flow.run.stop", runCard(store)!.id)
    await waitFor(() => runCard(store)?.payload.phase === "stopped")
    expect(runCard(store)?.payload.observationError).toBe("Cancel failed.")
    const before = historyReads(double)

    expect((await controller.commands.run("runs.open", "run-w12")).status).toBe("executed")
    await waitFor(() => historyReads(double) > before)
    expect(runCard(store)?.payload.observationError).toBeUndefined()
  })
})

describe("wave 12 §4 — the residuals", () => {
  test("a workflow plan limit embeds its upgrade door and stops provisioning", async () => {
    const store = await webStore()
    const double = relay({ provisionStatus: 402, provision: () => ({
      code: "plan_limit_exceeded", fault: "user", message: "Suspend one sandbox or upgrade.",
      plan_key: "free", limit_kind: "concurrent_sandboxes", upgrade_plan_key: "pro"
    }) })
    const controller = createAppController(store, silentAgent, double.services)
    await signIn(store)
    /* The door answers at once and provisions in the background, so the refusal lands on the durable card. */
    expect(said(await controller.commands.run("flow.create", "summarize my issues"))).toContain("flow-requested")
    await waitFor(() => authoringCard(store)?.payload.authoring?.launchError !== undefined)
    expect(authoringCard(store)?.payload.authoring?.launchError).toContain("Your plan is at its sandbox limit.")
    expect(authoringCard(store)?.status).toBe("error")
    expect(store.collections.cards.get("billing-plan-limit")).toMatchObject({ kind: "billing-plans", payload: { refusal: { upgrade_plan_key: "pro" } } })
    expect(double.calls.filter(call => call.path === "/api/workflow/provision")).toHaveLength(1)
    expect(double.state.launched).toHaveLength(0)
  })

})
