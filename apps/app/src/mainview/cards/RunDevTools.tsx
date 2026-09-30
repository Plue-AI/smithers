import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
/*
 * The DevTools view of a run (#2931): the node tree beside the selected
 * node's evidence, the way React DevTools shows a component tree beside its
 * props. Every value is the shared projection (`@smthrs/gateway/RunDevTools`)
 * over the trace the card already folds from its `run-events` subscription,
 * so the pane is live for as long as the card is, and the terminal and
 * `smthrs runs devtools` print the same tree. Selection is the card's
 * persisted `selection` through `runs.trace.select`; the card holds no state.
 */
import { devTools, inspect } from "@smthrs/gateway/RunDevTools"
import { StatusPill } from "@smthrs/ui"
import { describedFailure, FailureNotice } from "../FailureNotice"
import { timeLabel } from "../Timestamps"
import type { RunCommand } from "./CardFamily"
import { durationWords, type TraceModel, type TraceSpan } from "./RunTrace"
import { CALL_FAILED } from "./RunTraceCard"

const json = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const oneLine = (value: unknown): string => {
  try {
    return (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).split(/\r?\n/, 1)[0] ?? ""
  } catch {
    return String(value)
  }
}

/** The newest journal frames the pane lists under a node. */
export const FRAME_LIMIT = 100

const Block = ({ title, text }: { readonly title: string; readonly text: string }) => (
  <div className="run-trace-block">
    <h5>{title}</h5>
    <pre className="run-trace-code" tabIndex={0} aria-label={title}>{text}</pre>
  </div>
)

export const DevToolsPane = ({ model, selected, runId, latestSeq, onRunCommand }: {
  /** The trace of the whole journal, whatever the scrub cursor says: DevTools follows the live run. */
  readonly model: TraceModel
  readonly selected: TraceSpan
  readonly runId: string
  /** The newest sequence the card holds, so a selection parks the cursor at the live tail. */
  readonly latestSeq: number
  readonly onRunCommand: RunCommand
}) => {
  const tree = devTools(model)
  const inspection = inspect(model, selected.id, { frames: FRAME_LIMIT })
  const { node } = inspection
  const select = (nodeId: string) =>
    flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId, seq: latestSeq }))
  return (
    <div className="run-devtools" data-testid={`run-devtools-${runId}`}>
      <ol className="run-trace-tree run-devtools-tree" aria-label="Nodes">
        {tree.nodes.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="run-trace-node"
              data-devtools-node={row.id}
              data-kind={row.kind}
              data-status={row.status}
              data-depth={row.depth}
              aria-pressed={row.id === node.id}
              style={{ paddingLeft: `${0.5 + row.depth * 0.875}rem` }}
              {...select(row.id === node.id && row.kind !== "run" ? model.root.id : row.id)}
            >
              <span className="run-trace-dot" data-status={row.status} aria-hidden />
              <span className="run-trace-label">{row.label}</span>
              <span className="run-trace-status">{row.status === "completed" ? "" : row.status}</span>
              <span className="run-trace-duration">{row.durationMs === undefined ? "" : durationWords(row.durationMs)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="run-trace-pane run-devtools-inspect" data-testid={`run-devtools-inspect-${runId}`} data-span={node.id}>
        <h5 className="run-trace-pane-title">
          <span className="run-trace-pane-kind">{node.kind}</span> · {inspection.path.join(" / ")} <StatusPill status={node.status} />
        </h5>
        <dl className="run-trace-kv">
          {node.startedAt > 0 ? <><dt>started</dt><dd>{timeLabel(node.startedAt)}</dd></> : null}
          {node.durationMs !== undefined
            ? <><dt>duration</dt><dd>{durationWords(node.durationMs)}{node.endedAt === undefined ? " · open" : ""}</dd></>
            : null}
          {inspection.seat !== undefined ? <><dt>seat</dt><dd>{inspection.seat}</dd></> : null}
          {inspection.tokens !== undefined
            ? <><dt>tokens</dt><dd>{inspection.tokens.input} in / {inspection.tokens.output} out</dd></>
            : null}
          {inspection.childRunId !== undefined ? <><dt>child</dt><dd>{inspection.childRunId}</dd></> : null}
          {inspection.event !== undefined
            ? <><dt>journal</dt><dd>{inspection.event}{node.sequence === undefined ? "" : ` · #${node.sequence}`}</dd></>
            : null}
          {node.children > 0 ? <><dt>children</dt><dd>{node.children}</dd></> : null}
        </dl>
        {inspection.source !== undefined ? <Block title="Script" text={inspection.source} /> : null}
        {inspection.printed !== undefined ? <Block title="Printed" text={inspection.printed} /> : null}
        {inspection.input !== undefined ? <Block title="Input" text={json(inspection.input)} /> : null}
        {inspection.output !== undefined ? <Block title="Output" text={inspection.output} /> : null}
        {inspection.failure !== undefined
          ? (
            <FailureNotice className="run-trace-block run-trace-failure" data-testid="run-trace-failure"
              failure={describedFailure("run.trace.call", CALL_FAILED, inspection.failure)} />
          )
          : null}
        {inspection.fields.length > 0
          ? (
            <Block
              title="Fields"
              text={inspection.fields.map(([key, value]) => `${key.padEnd(12)} ${json(value)}`).join("\n")}
            />
          )
          : null}
        <div className="run-trace-block">
          <h5>
            Frames{" "}
            <span className="run-devtools-count" data-testid={`run-devtools-frames-${runId}`}>
              {inspection.frames.length === inspection.frameCount
                ? inspection.frameCount
                : `${inspection.frames.length} of ${inspection.frameCount}`}
            </span>
          </h5>
          {inspection.frames.length === 0 ? null : (
            <ol className="run-devtools-frames" aria-label="Frames">
              {inspection.frames.map((frame) => (
                <li key={frame.sequence} data-frame={frame.sequence}>
                  {/* A native disclosure: Enter opens the whole record, no state of the card's own. */}
                  <details className="run-devtools-frame">
                    <summary>
                      <span className="run-devtools-seq">#{frame.sequence}</span>
                      <span className="run-devtools-kind">{frame.kind}</span>
                      <span className="run-devtools-at">{frame.at > 0 ? timeLabel(frame.at) : ""}</span>
                      <code className="run-devtools-payload">{oneLine(frame.payload)}</code>
                    </summary>
                    <pre className="run-trace-code" tabIndex={0} aria-label={`Frame ${frame.sequence}`}>{json(frame.payload)}</pre>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
