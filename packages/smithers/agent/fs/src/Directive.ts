/**
 * Compiles serialized placement literals into core placement annotations.
 *
 * @since 0.1.0
 */

import * as Placement from "@smthrs/core/Placement"

/**
 * A placement literal produced by registry discovery.
 *
 * @category models
 * @since 0.1.0
 */
export type Literal = "client" | "local" | "sandbox" | "remote"

/**
 * Compiles a discovered placement literal into the corresponding core value.
 *
 * Registry discovery has already normalized source directives (including
 * `"use server"`) before this boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const compile = (literal: Literal): Placement.Placement => {
  switch (literal) {
    case "client":
      return Placement.client()
    case "local":
      return Placement.local()
    case "sandbox":
      return Placement.sandbox()
    case "remote":
      return Placement.remote()
  }
}
