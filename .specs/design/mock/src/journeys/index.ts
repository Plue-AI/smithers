import type { Journey } from "../journey"
import { j1 } from "./j1"
import { j2 } from "./j2"
import { j3 } from "./j3"
import { j4 } from "./j4"
import { j5 } from "./j5"
import { j6 } from "./j6"
import { j7 } from "./j7"
import { j8 } from "./j8"
import { agentAtWork } from "./agent"
import { askSmithers } from "./ask"
import { j10 } from "./j10"
import { states } from "./states"
import { insideRun } from "./run"
import { later } from "./later"

/** Journey order follows the spec (J1–J5 are P0); unbuilt ones are absent, never stubbed. */
export const JOURNEYS: ReadonlyArray<Journey> = [j1, j2, j10, j3, j4, j5, j6, j7, j8, insideRun, agentAtWork, askSmithers, states, later]
