import { flowAction } from "./flows/FlowAction"
/*
 * The monogram avatar every identity wears, and the door its name is.
 *
 * A name that resolves to a configured agent profile is the button door of
 * `agent.list` (the roster card names the profile); any other name is text. The avatar is a
 * two-letter monogram on the identity's lane color (Persona.ts), or the
 * persona's own image when it has one. Sizes: 20 (rows), 28 (message heads).
 */
import type { RunCommand } from "./cards/CardFamily"
import { monogram, personaLane, type PersonaRef } from "./Persona"

export const Monogram = ({ persona, size = 20 }: { readonly persona: PersonaRef; readonly size?: 16 | 20 | 28 }) =>
  persona.iconUrl !== undefined ?
    <img className="agent-mark" data-size={size} src={persona.iconUrl} alt="" width={size} height={size} /> :
    <span className="agent-mark" data-size={size} data-lane={personaLane(persona.id)} aria-hidden>{monogram(persona.name)}</span>

/** Monogram plus name; the name is a door when the identity is an agent. */
export const AgentMark = ({ persona, size = 20, onRunCommand, nameless = false }: {
  readonly persona: PersonaRef
  readonly size?: 16 | 20 | 28
  readonly onRunCommand?: RunCommand | undefined
  /** The avatar alone, with the name as its label. */
  readonly nameless?: boolean
}) => {
  const label = nameless ? <span className="ghc-visually-hidden">{persona.name}</span> : <span className="agent-mark-name">{persona.name}</span>
  if (persona.agentId !== undefined && onRunCommand !== undefined) {
    return (
      <button type="button" className="agent-mark-door" data-agent={persona.agentId} aria-label={nameless ? persona.name : undefined}
        {...flowAction(onRunCommand, "agent.list")}>
        <Monogram persona={persona} size={size} />
        {label}
      </button>
    )
  }
  return <span className="agent-mark-door" data-plain>{<Monogram persona={persona} size={size} />}{label}</span>
}
