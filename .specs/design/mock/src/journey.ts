/*
 * A journey is a setup plus ordered steps. Playing step i rebuilds the state
 * from setup by applying steps 0..i-1 instantly, then animates step i: the
 * pointer travels to its target, any typing plays, the act applies, and the
 * frame holds for the step's dwell. Captions are narration for reviewers and
 * never appear inside the depicted product.
 */
import { resetIds, type ActorId, type State } from "./world"

export interface Typing {
  /** An input id the frame renders (composer, steer:<branch>, answer:<todo>, terminal:<id>, line:<path>:<n>). */
  readonly into: string
  readonly text: string
  /** Text already in the input; typing appends to it. */
  readonly after?: string
  /** Who types; defaults to the step's viewer. */
  readonly viewer?: ActorId
  /** Shown on every screen as it is typed: a live co-edited line, not a private input. */
  readonly shared?: boolean
}

export interface Step {
  /** Narration shown in the player, outside the product. */
  readonly caption: string
  /** Whose screen the pointer and typing belong to. */
  readonly viewer?: ActorId
  /** A selector inside that viewer's frame; the pointer travels there and clicks before the act. */
  readonly target?: string
  /** Point at the target without pressing it. */
  readonly hover?: boolean
  /** After the act, scroll these elements into view on each listed screen. */
  readonly show?: ReadonlyArray<{ readonly viewer: ActorId; readonly target: string }>
  /** Before anything plays, scroll these into view (what the step is about to change). */
  readonly reveal?: ReadonlyArray<{ readonly viewer: ActorId; readonly target: string }>
  /** Several entries type at the same time (two people in one file). */
  readonly typing?: Typing | ReadonlyArray<Typing>
  /** A chord the viewer presses, shown as a key cap (e.g. "⌘K"). */
  readonly keys?: string
  /** How long the frame holds after the act, in ms. */
  readonly hold?: number
  /** What the click itself changes (focus moves, a tab opens) before any typing plays. */
  readonly pre?: (state: State) => void
  readonly act: (state: State) => void
}

export interface Journey {
  readonly id: string
  readonly title: string
  /** The caption before the first step plays. */
  readonly intro: string
  /** Where the spec defines it, e.g. "mvp.md J3". */
  readonly spec: string
  /** One frame per viewer; two viewers render side by side. "github" renders the GitHub side. */
  readonly viewers: ReadonlyArray<ActorId>
  /** The pull request the "github" frame shows. */
  readonly githubPr?: number
  readonly setup: () => State
  readonly steps: ReadonlyArray<Step>
}

/** The state before step `index` plays (index 0 is the setup). */
export const stateBefore = (journey: Journey, index: number): State => {
  resetIds()
  const state = journey.setup()
  for (const step of journey.steps.slice(0, index)) apply(state, step)
  return state
}

export const apply = (state: State, step: Step): void => {
  state.seq += 1
  step.pre?.(state)
  step.act(state)
}

/** The state while step `index` plays, after its click and before its act. */
export const stateDuring = (journey: Journey, index: number): State => {
  const state = stateBefore(journey, index)
  journey.steps[index]?.pre?.(state)
  return state
}

export const DEFAULT_HOLD = 1900
export const POINTER_MS = 650
export const KEY_MS = 34
