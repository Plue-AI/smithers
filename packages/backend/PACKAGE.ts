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
    Smithers.file("internal/services/install_setup_session.go"),
    Smithers.file("internal/routes/github_app_setup.go"),
    Smithers.file("internal/middleware/effective_origin.go"),
    Smithers.file("db/product/queries/github_app.sql"),
    Smithers.file("db/product/migrations/0105_github_app.sql"),
    Smithers.file("//docs/api/openapi/install.yaml")
  ]
})

/** The backend documentation freshness gate.
 * @since 1.0.0
 * @category packages
 */
export const Package = Smithers.Package({ targets: { docs } })
