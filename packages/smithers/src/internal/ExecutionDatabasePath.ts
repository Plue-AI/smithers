/**
 * Pure database location shared with the public NodeControl projection.
 * @since 1.0.0
 */

import { join } from "node:path"
import * as Project from "../Project.ts"

/**
 * Resolves the project's engine.db without opening it.
 * @category constructors
 * @since 1.0.0
 */
export const executionDatabasePath = (root: string): string => join(Project.stateDirectory(root), "engine.db")
