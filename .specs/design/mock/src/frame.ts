/* What every card in one person's screen can read: the world, whose screen it is, and live typing. */
import { createContext, useContext } from "react"
import type { ActorId, State } from "./world"

export interface FrameValue {
  readonly state: State
  readonly me: ActorId
  /** Text being typed into an input by the playing step, keyed by input id. */
  readonly typed: Readonly<Record<string, string>>
}

export const FrameContext = createContext<FrameValue | null>(null)

export const useFrame = (): FrameValue => {
  const value = useContext(FrameContext)
  if (value === null) throw new Error("card rendered outside a frame")
  return value
}

/** The value an input shows: the playing step's typing, else the stored value. */
export const typedOr = (frame: FrameValue, input: string, stored: string): string => frame.typed[input] ?? stored
