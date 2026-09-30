import { useLiveQuery } from "@tanstack/react-db"
import { Sparkles } from "lucide-react"
import { useMemo, useState } from "react"
import { useController } from "./ControllerContext"
import { SurfaceHeader } from "./SurfaceChrome"

/** What a dump reads off any collection: a live row count and its rows. */
type DumpedCollection = { readonly size: number; readonly values: () => Iterable<unknown> }

/*
 * One collection, dumped only while it is open. The panel re-renders on every
 * dispatch, so copying and stringifying thirteen collections' rows for a
 * closed <details> is work nobody is reading; `size` is a live count the
 * collection already keeps.
 */
function CollectionDump({ name, collection }: { readonly name: string; readonly collection: DumpedCollection }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <code>{name}</code> <span>{collection.size} rows</span>
        </summary>
        {open ? <pre className="devtools-json">{JSON.stringify([...collection.values()].slice(-50), null, 2)}</pre> : null}
      </details>
    </li>
  )
}

/*
 * The admin dev-tools panel (§2b/§2d): the machinery, visible for admin
 * sessions ONLY — for everyone else it is absent (the commands never
 * register, so devtoolsOpen can never turn true). Chrome attached to the
 * chat, composed from store state like everything else.
 */
export function DevtoolsPanel() {
  const controller = useController()
  const { data: toolCallRows } = useLiveQuery(controller.store.collections.toolCalls)
  const { data: transitionRows } = useLiveQuery(controller.store.collections.transitions)
  const toolCalls = useMemo(
    () => [...toolCallRows].sort((left, right) => left.createdAt - right.createdAt).slice(-30),
    [toolCallRows]
  )
  const identity = controller.store.collections.identitySessions.get("identity")
  const billing = controller.store.collections.billingAccounts.get("billing")
  const registryState = controller.commands.state()
  const transitions = useMemo(
    () => [...transitionRows].sort((left, right) => right.revision - left.revision).slice(0, 100),
    [transitionRows]
  )
  const collections = Object.entries(controller.store.collections) as ReadonlyArray<[string, DumpedCollection]>
  // The ring as rows: the controller's serialized read is for the human who types /debug.net.
  const netEntries = controller.netTapEntries()
  return (
    <aside data-keyboard-pane="Dev tools" className="devtools-panel" aria-label="Dev tools">
      <SurfaceHeader
        icon={<Sparkles size={17} aria-hidden="true" />}
        title="Dev tools"
        subtitle="The machinery, live"
        closeCommand="admin.devtools"
        onClose={() => controller.runCommand("admin.devtools")}
      />
      <div className="devtools-sections">

        <section className="devtools-section" aria-label="Store collections">
          <h3>Store · {controller.store.persistenceMode}</h3>
          <ul className="devtools-transitions">
            {collections.map(([name, collection]) => <CollectionDump key={name} name={name} collection={collection} />)}
          </ul>
        </section>
        <section className="devtools-section" aria-label="Transitions">
          <h3>Transitions</h3>
          <ul className="devtools-transitions">
            {transitions.map((record) => (
              <li key={record.id}>
                <details>
                  <summary>
                    <code>
                      #{record.revision} {record.type}
                    </code>{" "}
                    <span>{record.actor}</span>
                  </summary>
                  <pre className="devtools-json">{record.payload}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
        <section className="devtools-section" aria-label="Network tap">
          <h3>Network</h3>
          {netEntries.length === 0 ? <p className="devtools-empty">No requests yet.</p> : (
            <ul className="devtools-net">
              {netEntries.slice(0, 30).map((entry) => (
                <li key={`${entry.at}-${entry.url}`}>
                  <code>
                    {entry.method} {entry.url.replace(/^https?:\/\/[^/]+/, "")} {entry.status} {entry.ms}ms
                  </code>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="devtools-section" aria-label="Tool calls">
          <h3>Tool calls</h3>
          {toolCalls.length === 0 ?
            <p className="devtools-empty">No tool calls yet.</p> :
            (
              <ul className="devtools-toolcalls">
                {toolCalls.map((record) => (
                  <li key={record.id}>
                    <code>{record.name}</code>
                    <pre>{record.arguments}</pre>
                    <pre>{record.result}</pre>
                  </li>
                ))}
              </ul>
            )}
        </section>
        <section className="devtools-section" aria-label="Flow registry">
          <h3>Registry</h3>
          <ul className="devtools-registry">
            {controller.commands.entries().map((entry) => (
              <li key={entry.binding.descriptor.name}>
                <code>{entry.binding.descriptor.name}</code>{" "}
                <span>{entry.binding.descriptor.modelInvocable ? "both" : "user"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="devtools-section" aria-label="State snapshot">
          <h3>State</h3>
          <pre className="devtools-json">{JSON.stringify(registryState, null, 2)}</pre>
        </section>
        <section className="devtools-section" aria-label="Session facts">
          <h3>Session</h3>
          <pre className="devtools-json">
						{JSON.stringify(
							{
								identity:
									identity === undefined
										? null
										: {
												state: identity.state,
												login: identity.login,
												admin: identity.admin,
											},
								billing: billing === undefined ? null : { state: billing.state, totalUsd: billing.totalUsd },
								repositories: [...controller.store.collections.repositories.keys()],
							},
							null,
							2,
						)}
          </pre>
        </section>
      </div>
    </aside>
  )
}
