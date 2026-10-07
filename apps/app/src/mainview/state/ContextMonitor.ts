import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import type { HttpTurn } from "./HttpTurn"

/** Inspect reads the same verified, durable preflight as the answer. No new request or inference. */
export const contextMonitor = (turn: HttpTurn): MonitorCard | undefined => {
  const result = turn.preflight
  if (result === undefined) return undefined
  const selected = turn.preflightPhase !== "started"
  const state = turn.status === "active" ? "running" : turn.status === "complete" ? "done"
    : turn.status === "failed" ? "failed" : "interrupted"
  const took = result.durationMs / 1000
  const output = { candidates: result.candidates, choices: result.context, model: result.model }
  return {
    id: turn.turnId, flow: "app-agent", version: "1", title: "App agent", state,
    attempts: [{ n: 1, run_id: turn.turnId, state,
      graph: [{ id: "preflight", label: "Preflight", state: selected ? "done" : state === "running" ? "current" : "failed", deps: [] }],
      steps: [{ key: "preflight#1", id: "preflight", k: 1, label: "Preflight",
        state: selected ? "done" : "started", took_s: took,
        input: { candidates: result.candidates }, ...(selected ? { output } : {}) }],
      phases: [{ id: `${turn.turnId}:preflight`, step: "preflight#1", title: "Preflight", took_s: took, tone: "ok",
        cells: [{ id: `${turn.turnId}:context`, kind: "context", label: "Preflight", took_s: took,
          output: JSON.stringify(selected ? output : { candidates: result.candidates, model: result.model }, null, 2) }] }]
    }], waits: [], tokens: 0, time_s: took, cost_usd: 0, engine: []
  }
}
