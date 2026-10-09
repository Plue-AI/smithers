import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema, type Card } from "@smthrs/rpc/Cards"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import App from "../App"
import { CardView } from "../ChatCards"
import { ControllerTestProvider } from "../ControllerContext"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, settled, unavailableAgent, waitFor } from "./TestFixtures"

GlobalRegistrator.register()
afterAll(async () => {
  // React's scheduler drains unmount work on a macrotask that reads `window`.
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const createAppController = scopedControllers()

/** An agent that replays a fixed server-emitted frame stream for each turn. */
const scriptedAgent = (frames: ReadonlyArray<AgentTurnFrame>): AgentPort => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  return {
    available: true,
    startTurn: async (request) => {
      queueMicrotask(() => {
        for (const frame of frames) {
          for (const listener of listeners) listener({ ...frame, runId: request.runId })
        }
      })
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const planCard: Card = {
  id: "card-plan",
  kind: "plan",
  title: "Ship the MVP",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload: {
    items: [
      { id: "item-1", title: "Wave 1 skeleton", status: "active" },
      { id: "item-2", title: "Wave 2 flows", status: "pending" }
    ]
  }
}

const approvalCard: Card = {
  id: "card-approval",
  kind: "approval",
  title: "Deploy to production",
  status: "active",
  createdAt: 2,
  ordinal: 2,
  payload: { capability: "deploy:production", detail: "wrangler deploy" }
}

const statusCard: Card = {
  id: "card-status",
  kind: "status",
  title: "Analyzing repository",
  status: "active",
  createdAt: 3,
  ordinal: 3,
  payload: { progress: 0.5, note: "Halfway there" }
}

const balanceCard: Card = {
  id: "billing-balance",
  kind: "balance",
  title: "Balance",
  status: "active",
  createdAt: 4,
  ordinal: 4,
  payload: {
    totalUsd: "500",
    state: "ok",
    allowedToStartWork: true,
    lifetimeChargedUsd: "0",
    chargeCount: 0,
    introUsd: "500"
  }
}

describe("server-emitted card frames", () => {
  /*
   * The host runs the turn (90ef5aaccb); its card frames reach the browser in
   * the shared conversation the install serves. A card's later frame is its
   * latest record, the turn's cards never enter the browser's own journal,
   * and a runtime approval the browser holds still shows beside them.
   */
  test("model presentation and runtime approvals land as plan, approval, and status cards", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const frames: ReadonlyArray<AgentTurnFrame> = [
      { runId: "run-turn", type: "card", card: planCard },
      { runId: "run-turn", type: "card", card: statusCard },
      { runId: "run-turn", type: "card", card: { ...statusCard, payload: { progress: 1, note: "Analysis complete" } } },
      { runId: "run-turn", type: "delta", kind: "text", text: "Cards are live." },
      { runId: "run-turn", type: "done" }
    ]
    const turn = { id: "turn", author: 1, authorLogin: "will", runId: "run-turn", prompt: "show me the state of things", state: "completed", frames }
    const controller = createAppController(store, unavailableAgent, {
      bootstrap: { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: ["install"], authFlow: "credentials", sandbox: null },
      fetchImpl: async (input) => {
        if (String(input) === "/api/conversations/main") return Response.json({ id: "main", entries: [turn] })
        if (String(input).endsWith("/view-state")) return Response.json({})
        return Response.json({}, { status: 404 })
      }
    })
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: approvalCard }).isPersisted.promise
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
      await waitFor(() => host.querySelector('[data-shared-turn="turn"]') !== null)
      expect(host.querySelectorAll('[data-testid="card-card-plan"][data-kind="plan"]')).toHaveLength(1)
      expect(host.querySelectorAll('[data-testid="card-card-approval"][data-kind="approval"]')).toHaveLength(1)
      const status = host.querySelectorAll('[data-testid="card-card-status"][data-kind="status"]')
      expect(status).toHaveLength(1)
      expect(status[0]?.textContent).toContain("Analysis complete")
      expect(status[0]?.textContent).not.toContain("Halfway there")
      expect(host.textContent).toContain("Cards are live.")

      expect([...store.collections.cards.keys()]).toEqual(["card-approval"])
      const upserts = [...store.collections.transitions.values()].filter((record) => record.type === "card.upsert")
      expect(upserts.map((record) => record.actor)).toEqual(["system"])
    } finally {
      flushSync(() => root.unmount())
      host.remove()
    }
  })

  test("render plans and status while legacy approval payloads stay dark without actor authority", () => {
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onConnectGitHub: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const planMarkup = renderToStaticMarkup(<CardView card={planCard} {...cardViewHandlers} />)
    expect(planMarkup).toContain("data-kind=\"plan\"")
    expect(planMarkup).toContain("Wave 1 skeleton")

    const approvalMarkup = renderToStaticMarkup(
      <CardView card={approvalCard} {...cardViewHandlers} />
    )
    expect(approvalMarkup).toContain("data-kind=\"approval\"")
    expect(approvalMarkup).toContain("Deploy to production")
    expect(approvalMarkup).not.toContain("deploy:production")
    expect(approvalMarkup).not.toContain('data-flow="approval.approve"')
    expect(approvalMarkup).not.toContain('data-flow="approval.deny"')

    const statusMarkup = renderToStaticMarkup(
      <CardView card={statusCard} {...cardViewHandlers} />
    )
    expect(statusMarkup).toContain("data-kind=\"status\"")
    expect(statusMarkup).toContain("Halfway there")
  })

  /*
   * Ask 8 (will, 2026-09-02): "when I maximize a file I have no way of
   * minimizing it". The way back is a NAMED button — Restore — in the header
   * slot the maximize button held, bound to the restore flow that already
   * exists (card.minimize), never a new one.
   */
  test("a maximized card names its way back: a Restore button on card.minimize", () => {
    const handlers = {
      onDecideApproval: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onConnectGitHub: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const embedded = renderToStaticMarkup(<CardView card={statusCard} maximized={false} {...handlers} />)
    expect(embedded).toContain("data-flow=\"card.maximize\"")
    expect(embedded).not.toContain("Restore")

    const maximized = renderToStaticMarkup(<CardView card={statusCard} maximized {...handlers} />)
    expect(maximized).toContain("data-flow=\"card.minimize\"")
    expect(maximized).toContain("data-testid=\"card-minimize-card-status\"")
    expect(maximized).toContain("Restore")
    expect(maximized).toContain("aria-label=\"Restore\"")
    expect(maximized).not.toContain("Minimize card")
  })

  test("a runtime approval carries the run identity the decision round-trips against", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const linkedApproval: Card = {
      ...approvalCard,
      payload: {
        capability: "deploy:production",
        runId: "run_01",
        requestId: "approve",
        approval: {
          target: { _tag: "Node", runId: "run_01", requestId: "approve", digest: "d", envelope: {} },
          scope: "run",
          idempotencyKey: "approve:approve"
        }
      }
    }
    const controller = createAppController(
      store,
      scriptedAgent([
        { runId: "turn", type: "delta", kind: "text", text: "Decision needed." },
        { runId: "turn", type: "done" }
      ])
    )
    await store.dispatch({ type: "card.upsert", actor: "system", card: linkedApproval }).isPersisted.promise
    controller.send("deploy it")
    await settled()
    const card = store.collections.cards.get("card-approval")
    expect(card?.kind).toBe("approval")
    if (card?.kind === "approval") {
      expect(card.payload.runId).toBe("run_01")
      expect(card.payload.requestId).toBe("approve")
      // The runtime stores the submit-ready envelope with the card, so a
      // decision hands back exactly what the gateway published.
      expect(card.payload.approval).toMatchObject({ target: { _tag: "Node", requestId: "approve" } })
    }
  })

  test("old balance cards keep their data in a titled read-only legacy card", () => {
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onConnectGitHub: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const markup = renderToStaticMarkup(<CardView card={balanceCard} {...cardViewHandlers} />)
    expect(CardSchema.parse(balanceCard)).toEqual(balanceCard)
    expect(markup).toContain("Balance")
    expect(markup).not.toContain("<button")
  })

  test("a quiet or stopped run card never wears a Running pill (wave 12 §3, review)", () => {
    /*
     * Review pass: §3's two new phases fell through to the `running` pill, so
     * a card whose body read "This run has gone quiet — … I stopped checking"
     * still glanced as **Running**. The pill is the most-read claim on a card;
     * "Running" is exactly what neither state can vouch for.
     */
    const cardViewHandlers = {
      maximized: false,
      onDecideApproval: () => {},
      onRecoAction: () => {},
      onRepoToggle: () => {},
      onReposSelectAll: () => {},
      onReposSelectNone: () => {},
      onReposConfirm: () => {},
      onMaximize: () => {},
      onMinimize: () => {},
      onConnectGitHub: () => {},
      onRunWorkflow: () => {},
      onStopRun: () => {},
      onRetryRun: () => {},
      onChooseWorkflowRepo: () => {},
      worldDocuments: [],
      onChangeWorldDocument: () => {},
      onRunCommand: () => {}
    }
    const runCard = (phase: "running" | "quiet" | "stopped"): Card => ({
      id: "flow-run-run-1",
      kind: "run-trace",
      title: "Creating a flow: will/flows",
      status: "active",
      createdAt: 5,
      ordinal: 5,
      payload: {
        runId: "run-1",
        repo: "will/flows",
        workflow: "create-flow",
        phase,
        steps: ["The run started."],
        result: null,
        lastSeq: 1
      }
    })
    const quiet = renderToStaticMarkup(<CardView card={runCard("quiet")} {...cardViewHandlers} />)
    expect(quiet).toContain("No recent progress")
    expect(quiet).not.toContain("Running")
    expect(quiet).toContain("Quiet")
    // The two acts are on the card: the one `flow.run` flow with its operation (c89fb48890).
    const runAct = (operation: string) =>
      `data-flow="flow.run" data-flow-args="${JSON.stringify({ cardId: "flow-run-run-1", operation }).replaceAll("\"", "&quot;")}"`
    expect(quiet).toContain(runAct("retry"))
    expect(quiet).toContain(runAct("stop"))

    const stopped = renderToStaticMarkup(<CardView card={runCard("stopped")} {...cardViewHandlers} />)
    expect(stopped).toContain("Stopped watching")
    expect(stopped).not.toContain("Running")
    expect(stopped).toContain("Stopped")

    // The live phase is untouched: a running run still reads Running.
    expect(renderToStaticMarkup(<CardView card={runCard("running")} {...cardViewHandlers} />)).toContain("Running")
  })
})
