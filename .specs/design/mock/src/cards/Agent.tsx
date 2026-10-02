/*
 * The Agent card (mvp.md §6.14, J11): one agent the factory uses, opened from
 * the flow step it works. Its instructions are a Markdown file in the
 * repository, where its tools and permissions live too; changing them is a
 * TODO like any change, so the card only links the file. Its model is the
 * owner's setting: a select that applies at once and keeps the change as a
 * receipt. Everyone else reads the model.
 */
import { Check, ChevronDown } from "lucide-react"
import { Avatar, Card } from "../parts"
import { useFrame } from "../frame"
import { member } from "../world"
import type { ExtraCardProps } from "./extra"

/* What the install's model access offers coding agents (Settings, mvp.md §6.5), each with its price per million tokens, in and out. */
const MODELS: ReadonlyArray<{ readonly name: string; readonly price: string }> = [
  { name: "Fable 5.1", price: "$10 / $50" },
  { name: "Opus 5.5", price: "$4 / $20" },
  { name: "Sonnet 5.5", price: "$2 / $10" }
]

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-")

export const AgentCard = ({ id, target, view }: ExtraCardProps) => {
  const { state: { world, seq }, me } = useFrame()
  const agent = world.agents?.find(each => each.id === target)
  if (agent === undefined) return null
  const owner = member(world, me)?.role === "owner"
  return (
    <Card id={id} kind="agent" title={<span className="mvp-agent-title"><Avatar world={world} who="agent" size={18} />{agent.id.charAt(0).toUpperCase()}{agent.id.slice(1)} agent</span>}>
      <dl className="mvp-settings mvp-agent">
        <dt>Instructions</dt>
        <dd><button type="button" className="mvp-file-link" data-mock={`agent-instructions-${agent.id}`}>{agent.instructions}</button></dd>
        <dt>Model</dt>
        <dd>
          {!owner ? <span>{agent.model}</span> : (
            <span className="mvp-place">
              <button type="button" className="mvp-select" aria-haspopup="listbox" aria-expanded={view === "model"} aria-label={`Model: ${agent.model}`} data-mock={`agent-model-${agent.id}`}>
                <span>{agent.model}</span><ChevronDown size={14} aria-hidden="true" />
              </button>
              {view === "model" ? (
                <div className="mvp-menu mvp-model-menu" role="listbox" aria-label="Model">
                  {MODELS.map(model => (
                    <button key={model.name} type="button" role="option" aria-selected={model.name === agent.model} data-mock={`model-${slug(model.name)}`}>
                      {model.name}<span className="mvp-menu-note" title="Per million tokens, in / out">{model.price}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          )}
        </dd>
        <dt>Runs</dt>
        <dd className="mvp-agent-runs">
          {world.traces.filter(trace => trace.phases.some(phase => agent.steps.includes(phase.step))).slice(-3).map(trace => (
            <button key={trace.id} type="button" className="mvp-file-link" data-mock={`agent-run-${trace.id}`}>{trace.title}</button>
          ))}
        </dd>
      </dl>
      {agent.changed === undefined ? null : (
        <p className="mvp-receipt-line mvp-agent-receipt" data-fresh={agent.changed.seq === seq || undefined}>
          <Check size={14} aria-hidden="true" />{agent.changed.from} → <b>{agent.model}</b><Avatar world={world} who={agent.changed.by} size={16} />
        </p>
      )}
    </Card>
  )
}
