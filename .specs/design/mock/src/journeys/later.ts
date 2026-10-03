/*
 * Deferred from MVP (mvp.md §15, §16). Review material, not a journey: one
 * card lists every deferral, one line each with its issue, so Will can ratify
 * them visually.
 */
import type { Journey } from "../journey"
import { showCard, type State } from "../world"
import { BEN, seedState } from "./seed"

const setup = (): State => {
  const state = seedState([BEN])
  showCard(state, BEN, "later", "§16")
  return state
}

export const later: Journey = {
  id: "later",
  title: "Deferred from MVP",
  spec: "§16",
  intro: "What the MVP defers, one line each, with where the spec defers it and its issue. No release is promised for any of it.",
  viewers: [BEN],
  setup,
  steps: [
    { caption: "Will ratifies these deferrals, or names any the MVP must keep.", spec: "§16", hold: 4000, act: () => {} }
  ]
}
