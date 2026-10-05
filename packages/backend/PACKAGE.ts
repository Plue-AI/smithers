import { Smithers } from "@smthrs/targets"

/** Checks the App setup guide against the source it documents.
 * Refresh the receipt with `smthrs docs //packages/backend:docs --write`.
 * @since 1.0.0
 * @category documentation
 */
const docs = Smithers.Docs.Check({
  output: Smithers.file("docs/github-app.md"),
  stamp: Smithers.file("docs/github-app.stamp.json"),
  inputs: [
    Smithers.file("internal/services/github_app_manifest.go"),
    Smithers.file("internal/services/github_app_credentials.go"),
    Smithers.file("internal/services/github_synced_repos.go"),
    Smithers.file("internal/services/github_synced_delivery.go"),
    Smithers.file("internal/services/github_synced_events.go"),
    Smithers.file("internal/services/github_synced_conditional.go"),
    Smithers.file("internal/services/github_synced_cursor.go"),
    Smithers.file("internal/services/github_synced_poll.go"),
    Smithers.file("internal/services/landing_github_pull.go"),
    Smithers.file("internal/services/github_issue_text_writer.go"),
    Smithers.file("internal/services/mythical_issue_events.go"),
    Smithers.file("internal/services/mythical_github.go"),
    Smithers.file("internal/services/github_budget.go"),
    Smithers.file("internal/compose/main.go"),
    Smithers.file("internal/compose/github_sync.go"),
    Smithers.file("internal/compose/runtime_helpers.go"),
    Smithers.file("internal/auth/github.go"),
    Smithers.file("internal/services/install_setup_session.go"),
    Smithers.file("internal/routes/github_app_setup.go"),
    Smithers.file("internal/middleware/effective_origin.go"),
    Smithers.file("db/product/queries/github_app.sql"),
    Smithers.file("db/product/migrations/0105_github_app.sql"),
    Smithers.file("//docs/api/openapi/install.yaml")
  ]
})

/** Dark PostgreSQL label-snapshot regression, enabled when selected explicitly. */
const journeyTodoLabel = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("run-journey-todo-label.mjs")),
  srcs: [Smithers.glob("**/*.go"), Smithers.glob("db/product/migrations/*.sql"),
    Smithers.file("//go.mod"), Smithers.file("//go.sum")],
  deps: [], exclusive: true, cache: false, timeout: "15m", cwd: "packages/backend"
})

/** The backend documentation freshness gate.
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({ targets: { docs, journeyTodoLabel } })
