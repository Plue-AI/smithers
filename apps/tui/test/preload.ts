/**
 * Runs every `bun test` in this package inside one private temporary root
 * that is removed when the run ends; see `scratch.ts`. The hook is global
 * because a preload registers it. Deleting a full run's scratch repositories
 * takes over 15 s under load, past Bun's 5 s default hook timeout.
 */
import { afterAll } from "bun:test"
import { claim } from "./scratch.ts"

await import("../src/native.ts")

afterAll(claim(), 300_000)
