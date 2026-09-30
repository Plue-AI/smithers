/**
 * Reserved system-flow identifiers projected by the command-line interface.
 *
 * @since 0.1.0
 */

/**
 * The projection metadata for one reserved system flow.
 *
 * @since 0.1.0
 * @category models
 */
export interface SystemFlowEntry {
  readonly verb: string
  readonly flowId: `system/${string}`
  readonly projection: "procedure" | "systemFlow"
  readonly deployClass: boolean
  readonly planBearing: boolean
  /**
   * Whether a control plane may plan and run this reserved id.
   *
   * `false` means the row is command-line metadata and nothing else: the verb
   * is named here so the binary can refuse it by name, and no runtime may
   * offer it as a flow. `replay` was removed by the frozen rc.0 contract yet
   * every runtime turned the whole catalog into plannable flows, so
   * `plan({flowId: "system/replay"})` returned a real approval card and only a
   * later `run` failed. A removed feature that half works is exactly what the
   * contract forbids.
   */
  readonly plannable: boolean
}

/**
 * The authoritative command-line verb to reserved-flow map.
 *
 * `gc` is the retention verb: it resolves `@smthrs/engine-store`'s `retain`
 * operation, which deletes aged terminal runs with their attempts, clock
 * deadlines, deferred completions, journal entries, and time-travel archive
 * rows. It is a procedure rather than a deploy-class system flow because it
 * takes no plan and bears no approval envelope; the deletion is gated by the
 * operator invoking it, and automatic retention stays opt-in.
 *
 * @since 0.1.0
 * @category models
 */
export const catalog = [
  {
    verb: "plan",
    flowId: "system/plan",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "run",
    flowId: "system/run",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "release",
    flowId: "system/release",
    projection: "systemFlow",
    deployClass: true,
    planBearing: true,
    plannable: true
  },
  {
    verb: "serve",
    flowId: "system/serve",
    projection: "systemFlow",
    deployClass: true,
    planBearing: true,
    plannable: true
  },
  { verb: "up", flowId: "system/up", projection: "systemFlow", deployClass: true, planBearing: true, plannable: true },
  { verb: "ls", flowId: "system/ls", projection: "procedure", deployClass: false, planBearing: false, plannable: true },
  { verb: "ps", flowId: "system/ps", projection: "procedure", deployClass: false, planBearing: false, plannable: true },
  {
    verb: "logs",
    flowId: "system/logs",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "status",
    flowId: "system/status",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "cancel",
    flowId: "system/cancel",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "approve",
    flowId: "system/approve",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "deny",
    flowId: "system/deny",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "signal",
    flowId: "system/signal",
    projection: "procedure",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  { verb: "gc", flowId: "system/gc", projection: "procedure", deployClass: false, planBearing: false, plannable: true },
  {
    verb: "replay",
    flowId: "system/replay",
    projection: "systemFlow",
    deployClass: false,
    planBearing: false,
    plannable: false
  },
  {
    verb: "add",
    flowId: "system/add",
    projection: "systemFlow",
    deployClass: false,
    planBearing: true,
    plannable: true
  },
  {
    verb: "remove",
    flowId: "system/remove",
    projection: "systemFlow",
    deployClass: false,
    planBearing: true,
    plannable: true
  },
  {
    verb: "eject",
    flowId: "system/eject",
    projection: "systemFlow",
    deployClass: false,
    planBearing: true,
    plannable: true
  },
  {
    verb: "test",
    flowId: "system/test",
    projection: "systemFlow",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "init",
    flowId: "system/init",
    projection: "systemFlow",
    deployClass: false,
    planBearing: true,
    plannable: true
  },
  {
    verb: "doctor",
    flowId: "system/doctor",
    projection: "systemFlow",
    deployClass: false,
    planBearing: false,
    plannable: true
  },
  {
    verb: "migrate",
    flowId: "system/migrate",
    projection: "systemFlow",
    deployClass: false,
    planBearing: true,
    plannable: true
  },
  {
    // A build target declaring `approval: "required"`: its plan input is the
    // target's label and revision digest, and the build planner runs it only
    // once that plan is approved. The build executes it, never a control run.
    verb: "target",
    flowId: "system/target",
    projection: "systemFlow",
    deployClass: true,
    planBearing: true,
    plannable: true
  },
  {
    verb: "docs",
    flowId: "system/docs",
    projection: "systemFlow",
    deployClass: false,
    planBearing: false,
    plannable: true
  }
] as const satisfies ReadonlyArray<SystemFlowEntry>

/**
 * The catalog entries a control runtime may offer as flows.
 *
 * One list, so a composition that builds its own flow map (the CLI does) and
 * the runtimes' own defaults cannot disagree about which reserved ids exist.
 *
 * @since 0.1.0
 * @category models
 */
export const plannable: ReadonlyArray<SystemFlowEntry> = catalog.filter((entry) => entry.plannable)
