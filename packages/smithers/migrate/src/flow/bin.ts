#!/usr/bin/env node
/**
 * The `smithers-migrate` executable: the one module whose evaluation has a
 * side effect. Everything it runs is {@link module:Cli}.
 *
 * @since 1.0.0-rc.0
 */

import { NodeRuntime } from "@effect/platform-node"
import { main } from "./Cli.ts"

NodeRuntime.runMain(main)
