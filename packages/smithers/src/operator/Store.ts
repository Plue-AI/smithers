/**
 * Shared local persistence for operator commands.
 *
 * @since 1.0.0
 */

import { NodeCrypto } from "@effect/platform-node"
import { Layer } from "effect"
import { z } from "incur"
import type * as Environment from "../Environment.ts"
import * as ControlDatabase from "../internal/ControlDatabase.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"

/**
 * Connection fields shared by local operator commands.
 * @category schemas
 * @since 1.0.0
 */
export const localFields = {
  root: z.string().optional().describe("Project root (defaults to the nearest Smithers project)"),
  remote: z.string().optional().describe("Remote control server; local operator commands refuse this option")
}

/**
 * Parsed project selection for local operator commands.
 * @category models
 * @since 1.0.0
 */
export interface LocalOptions {
  readonly root?: string | undefined
  readonly remote?: string | undefined
}

/**
 * Resolves the project root and refuses remote operator access.
 * @category constructors
 * @since 1.0.0
 */
export const localRoot = (options: LocalOptions, environment?: Environment.Source): string =>
  Project.localRoot(options, environment ?? process.env)

/**
 * Shares the authoritative control database and its migration ledger.
 * @category layers
 * @since 1.0.0
 */
export const databaseLayer = (root: string) =>
  Layer.mergeAll(ControlDatabase.layer(NodeControl.databasePath(root)), NodeCrypto.layer)
