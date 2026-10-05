import type { MockJourney } from "./mock-steps.ts"
import type { RepoView } from "./validate.ts"

/** Shared fixtures for the proof registry tests: the contract's example entry and the tree it points into. */
export const validFeature = {
  id: "j1-merge-in-app",
  title: "Merge a TODO from the app",
  journey: "J1",
  spec: ".specs/product/mvp.md#j1-install-to-first-merged-todo-p0",
  mockSteps: ["j1#22"],
  status: "implemented",
  proof: [{ file: "apps/app/e2e/proof/j1.spec.ts", step: "j1-merge-in-app" }],
  docs: ["packages/backend/docs/mythical_items.md"],
  code: ["packages/backend/internal/routes/todos.go#L208-L238"],
  gap: ""
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

export const fixtureRepo = (files: Record<string, string>): RepoView => ({ read: path => files[path] })

export const fixtureFiles: Record<string, string> = {
  ".specs/product/mvp.md": "# MVP\n",
  "apps/app/e2e/proof/j1.spec.ts": 'await proofStep("j1-merge-in-app", async () => {})\n',
  "packages/backend/docs/mythical_items.md": "# TODOs\n",
  "packages/backend/internal/routes/todos.go": lines(300)
}

export const fixtureMock: MockJourney[] = [{ file: "j1", id: "j1", title: "Install", intro: "", steps: Array.from({ length: 30 }, (_, i) => `step ${i + 1}`) }]

