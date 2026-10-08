/**
 * Reference-host journeys that exclusive smthrs targets own. Ordinary real-E2E
 * runs neither discover them nor owe them coverage; a journey target enables
 * exactly one by naming its spec in SMITHERS_JOURNEY.
 */
export const journeySpecs = [
  "j1-activation.spec.ts",
  "j1.spec.ts",
  "keyboard-journeys.spec.ts",
  "setup.spec.ts",
  "wiki-obsidian.spec.ts",
  "fresh-repository.spec.ts",
  "wiki-generated-refresh.spec.ts",
  "wiki-coedit.spec.ts",
  "wiki-decision-follow.spec.ts",
  "todo-from-issue.spec.ts",
  "fork-drop-install.spec.ts",
  "todo-needs-you.spec.ts",
  "todo-evidence.spec.ts",
  "todo-merge.spec.ts",
  "todo-merge-order.spec.ts",
  "flow-activation.spec.ts",
  "flow-source-run.spec.ts",
  "duplicate-launch.spec.ts",
  "github-j10/merge-on-github.spec.ts",
  "github-j10/merge-on-github-continuation.spec.ts",
  "github-j10/pr-shape.spec.ts",
  "github-j10/foreign-push.spec.ts",
  "github-j10/sync-health.spec.ts",
  "ask-repository.spec.ts",
  "todo-stack-actions.spec.ts",
  "home.spec.ts",
  "todo-placement.spec.ts",
  "fork-add-to-stack.spec.ts",
  "branch-presence.spec.ts",
  "ssh-branch.spec.ts",
  "file-gone.spec.ts",
  "file-coedit.spec.ts",
  "file-intelligence.spec.ts",
  "install-origins.spec.ts"
] as const

/** The journey specs this run leaves out: all of them, except the one SMITHERS_JOURNEY enables. */
export const ignoredJourneys = (env: Record<string, string | undefined>): ReadonlyArray<string> => {
  const enabled = env.SMITHERS_JOURNEY ?? (env.SMITHERS_J1_ACTIVATION === "1" ? "j1-activation.spec.ts" : undefined)
  return journeySpecs.filter((spec) => spec !== enabled)
}
