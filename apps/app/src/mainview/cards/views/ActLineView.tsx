import { Marker } from "../../../../../../packages/smithers/ui/src/chat/Marker"
import "../../styles/views.css"

export type ActStep = { text: string; status?: "running" | "ok" | "error"; output?: string; exit_code?: number }
export type ActLineProps = { line: string; steps: ActStep[]; tone?: "failed" }

/** Tool disclosure is transient DOM chrome, shared by every agent. */
export function ActLineView({ line, steps, tone }: ActLineProps) {
  return <Marker variant="note" className="bubble-system-note tool-act-line" data-tone={tone}>
    {steps.length === 0 ? line : <details className="act-line-steps">
      <summary>{line}</summary>
      <ol>{steps.map((step, index) => <li key={index} data-status={step.status}>
        <code>{step.text}</code>
        {step.output ? <details className="act-line-output"><summary>Output{step.exit_code ? ` · exit ${step.exit_code}` : ""}</summary><pre>{step.output}</pre></details> : null}
      </li>)}</ol>
    </details>}
  </Marker>
}
