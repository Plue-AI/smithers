import type { DebugApiViewProps } from "@smthrs/rpc/DebugApiCard"
import { SetupActions } from "./SetupActions"

export function DebugApiView({ model, view, actions, onAction, onView }: DebugApiViewProps) {
  const selected = view.selected ?? model.selected
  const form = <SetupActions key={selected} actions={actions} onAction={onAction} />
  const op = model.operations.find(operation => operation.id === selected)
  return <article className="smithers-card mvp-debug-api" aria-label="Debug API" data-keyboard-pane="Debug API">
    <header className="smithers-card-header"><h2 className="smithers-card-title">Debug API</h2></header>
    <div className="debug-layout">
      <nav aria-label="Operations">{model.operations.length === 0 && <p className="debug-empty">No operations</p>}{[...new Set(model.operations.map(operation => operation.group))].map(group => <section key={group}>
        <h3>{group}</h3>{model.operations.filter(operation => operation.group === group).map(operation => <button key={operation.id} type="button" aria-pressed={selected === operation.id} onClick={() => onView({ selected: operation.id })}>
          <code>{operation.method} {operation.path}</code><span>{operation.summary}</span>
        </button>)}
      </section>)}</nav>
      <div className="debug-detail">
        {op && <h3><code>{op.method} {op.path}</code></h3>}
        {model.pending ? <div className="debug-pending" data-tone="attention">{form}</div> : form}
        {model.exchange && <section aria-label="Exchange">
          <h3>Request</h3><code>{model.exchange.request.method} {model.exchange.request.url}</code>
          <HeaderRows headers={model.exchange.request.headers} />
          {model.exchange.request.body !== undefined && <pre>{model.exchange.request.body}</pre>}
          {model.exchange.response && <><h3>Response <span>{model.exchange.response.status} · {model.exchange.response.duration_ms} ms</span></h3>
            <HeaderRows headers={model.exchange.response.headers} />{model.exchange.response.body !== "" && <pre>{model.exchange.response.body}</pre>}</>}
          {model.exchange.failure && <div className="debug-failure" data-tone="failed" role="status"><code>{model.exchange.failure.code ?? model.exchange.failure.class}{model.exchange.failure.status !== undefined && ` · ${model.exchange.failure.status}`}</code><p>{model.exchange.failure.message}</p></div>}
        </section>}
      </div>
    </div>
  </article>
}

function HeaderRows({ headers }: { headers: [string, string][] }) {
  return headers.length ? <dl className="debug-headers">{headers.map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : null
}
