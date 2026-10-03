import type { SecretsCard } from "../../src/SecretsCard.ts"

export const fixtures = {
  empty: { secrets: [] },
  all_branches: { secrets: [{ name: "GITHUB_TOKEN", scope: "all_branches" }] },
  main_only: { secrets: [{ name: "RELEASE_TOKEN", scope: "main_only" }] },
  mixed: { secrets: [{ name: "MODEL_KEY", scope: "all_branches" }, { name: "RELEASE_TOKEN", scope: "main_only" }] }
} satisfies Record<string, SecretsCard>
