import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import { runSourceCommand } from "@smthrs/ui/run-command"
import type { Card } from "../state/AppState"
import { codingPocOf } from "./CodingPoc"
import type { RunCommand } from "./CardFamily"

/** The retained measured files are text. Generated HTML is never executed in the app. */
export const CodingPocBody = ({ card, onRunCommand: sendRunCommand }: {
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onRunCommand: RunCommand
}) => {
  const poc = codingPocOf(card)
  if (poc === undefined) return null
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { result } = poc
  const first = result.findings[0] ?? ""
  return (
    <section className="coding-plan coding-poc" aria-label="Disposable prototype" data-poc-execution={poc.executionId}>
      <h4>Disposable prototype</h4>
      <p>Drafted and discarded. No build or tests ran.</p>
      <p>{first.length <= 240 ? first : `${first.slice(0, 240)}…`}</p>
      <button type="button" className="run-trace-filter" 
        {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId: card.payload.runId, nodeId: poc.spanId }))}>
        Inspect prototype execution
      </button>
      {card.payload.kind !== "prototype" && ["launching", "running", "waiting-approval", "reconnecting"].includes(card.payload.phase) ? (
        <button type="button" className="run-trace-filter" 
          {...flowAction(onRunCommand, "runs.steer", card.payload.runId)}>
          Give prototype feedback
        </button>
      ) : null}
      <details><summary>Review findings</summary><ul>{result.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul></details>
      <details>
        <summary>Retained source preview</summary>
        {result.changes.files.map(file => (
          <section className="coding-plan-detail" aria-label={file.path} key={file.path}>
            <h5><code>{file.path}</code></h5>
            <div className="coding-plan-paths">
              <div><h5>Before</h5><pre className="run-trace-code" tabIndex={0}>{file.before ?? "[absent]"}</pre></div>
              <div><h5>After</h5><pre className="run-trace-code" tabIndex={0}>{file.after ?? "[removed]"}</pre></div>
            </div>
          </section>
        ))}
        <dl className="run-trace-kv">
          <dt>Source commit</dt><dd><code>{result.source.commitId}</code></dd>
          <dt>Source JJ change</dt><dd><code>{result.source.changeId}</code></dd>
          <dt>Captured input digest</dt><dd><code>{result.changes.sourceDigest}</code></dd>
        </dl>
      </details>
      <details><summary>Feedback for the next plan</summary><pre className="run-trace-code" tabIndex={0}>{result.feedback}</pre></details>
    </section>
  )
}
