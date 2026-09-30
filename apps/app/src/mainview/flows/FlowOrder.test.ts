/*
 * The aggregator order gate for the Flows.ts split (wave 0, 2026-09-07).
 *
 * Flows.ts used to hold every declaration in one array; it now spreads one
 * block per namespace module from ./entries. The registration order is what
 * the slash menu, the agent catalog and the commands card all read, so the
 * split had to keep it. This test pins the pre-split order: every name that
 * existed before the split must still register, in the same relative order,
 * in the same plugin (base or admin). A lane that ADDS a flow in its own
 * module needs no edit here; a lane that deletes or moves one edits the list
 * it changed.
 */
import { describe, expect, test } from "bun:test"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows, guideFlows } from "./Flows"
import { nameOf } from "./registry"

/** Every controller call answers with nothing: registration never invokes a handler. */
const inertActions = new Proxy({}, {
  get: (_, key) => key === "snapshot" ? () => ({ pluginLibrary: true }) : () => undefined
}) as CommandActions

/** baseFlows at the split, in registration order. */
const PRE_SPLIT_BASE: ReadonlyArray<string> = [
  "connect",
  "world",
  "flows",
  "appearance.theme",
  "appearance.dark-mode",
  "debug.verbose",
  "system.recommend",
  "chat",
  "chat.retry",
  "chat.stop",
  "chat.send",
  "chat.clear",
  "browser.open",
  "flow.create",
  "flow.repo.choose",
  "flow.run.stop",
  "flow.run.retry",
  "flow.list",
  "flow.run",
  "triggers.list",
  "runs.list",
  "runs.open",
  "runs.resume",
  "runs.rerun",
  "runs.signal",
  "runs.steer",
  "runs.seat",
  "runs.thinking",
  "runs.tools",
  "runs.logs",
  "runs.steps",
  "runs.trace.filter",
  "runs.trace.select",
  "runs.events",
  "flow.run.stop-all",
  "approvals.list",
  "approvals.open",
  "card.maximize",
  "card.minimize",
  "card.dismiss",
  "frame.back",
  "frame.forward",
  "frame.fork",
  "chat.copy-message",
  "approval.approve",
  "approval.deny",
  "world.new-note",
  "world.select",
  "world.delete",
  "world.delete.confirm",
  "world.delete.cancel",
  "auth.sign-in",
  "auth.prompt",
  "auth.sign-out",
  "auth.request-access",
  "app.download",
  "app.download.prompt",
  "storage.recovery",
  "storage.recovery.export",
  "cloud.sign-in",
  "cloud.prompt",
  "cloud.sign-out",
  "toast.dismiss",
  "billing.balance",
  "billing.plans",
  "billing.upgrade",
  "billing.portal",
  "repos.import",
  "issues.list",
  "issues.view",
  "issues.create",
  "issues.close",
  "issues.reopen",
  "issues.comment",
  "prs.list",
  "prs.view",
  "prs.tab",
  "prs.create",
  "prs.land",
  "prs.review",
  "feature.prototype",
  "notifications.list",
  "notifications.read",
  "env.view",
  "env.set",
  "branches.list",
  "files.list",
  "files.read",
  "code.hover",
  "code.definition",
  "code.diagnostics",
  "github.app",
  "github.app.open",
  "github.reconcile",
  "github.mirror-sync",
  "github.mirror.retry-ref",
  "repos.import.retry",
  "sync.ops.show-more",
  "box.list",
  "box.open",
  "box.view",
  "box.terminal",
  "box.suspend",
  "box.resume",
  "box.sessions",
  "box.session.destroy",
  "box.delete",
  "box.facet",
  "box.files",
  "box.file",
  "box.services",
  "box.egress",
  "box.desktop",
  "box.desktop.rotate",
  "box.images",
  "egress.session",
  "change.request",
  "change.view",
  "change.diff",
  "change.land",
  "change.split",
  "change.resolve",
  "change.revert",
  "change.facet",
  "change.pins",
  "change.checks",
  "review.since-mine",
  "review.done",
  "review.ack",
  "review.reopen",
  "review.request",
  "review.unrequest",
  "findings.please-fix",
  "findings.not-useful",
  "chat.reload",
  "chat.commands",
  "agent.explain",
  "agent.list",
  "form.set",
  "form.submit",
  "tab.card",
  "tab.select",
  "tab.close",
  "repo.select",
  "repo.tree",
  "workspace.rename",
  "workspace.rename.edit",
  "files.add"
]

/** adminFlows at the split, in registration order. */
const PRE_SPLIT_ADMIN: ReadonlyArray<string> = [
  "admin.reset.ask",
  "admin.reset.cancel",
  "admin.reset",
  "admin.devtools",
  "debug.backend",
  "debug.snapshot",
  "debug.events",
  "debug.net",
  "debug.seams",
  "admin.allowlist.add",
  "admin.allowlist.remove",
  "admin.grant",
  "admin.grant.confirm",
  "admin.grant.cancel",
  "admin.requests",
  "admin.queue.approve",
  "admin.health"
]

describe("Flows.ts aggregator order", () => {
  test("baseFlows registers every pre-split flow in the pre-split order", () => {
    const names = baseFlows(inertActions).map(nameOf)
    expect(names.filter((name) => PRE_SPLIT_BASE.includes(name))).toEqual([...PRE_SPLIT_BASE])
  })

  test("adminFlows registers every pre-split admin flow in the pre-split order", () => {
    const names = adminFlows(inertActions).map(nameOf)
    expect(names.filter((name) => PRE_SPLIT_ADMIN.includes(name))).toEqual([...PRE_SPLIT_ADMIN])
  })

  test("no flow registers twice across the blocks", () => {
    const names = [...baseFlows(inertActions), ...guideFlows(inertActions), ...adminFlows(inertActions)].map(nameOf)
    const seen = new Set<string>()
    const duplicates = names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)))
    expect(duplicates).toEqual([])
  })
})
