/** `smthrs migrate --json` prints the same document the migrate package writes to report.json. */
import * as Report from "@smthrs/migrate/Report"
import { expect, it } from "vitest"
import * as Migrate from "../src/commands/Migrate.ts"

it("prints the report.json document for a migration report", () => {
  const report = new Report.MigrationReport({
    ...Report.empty("/project", "apply", "2026-09-27T00:00:00.000Z"),
    exitCode: 1,
    unresolved: [{
      construct: "Task",
      reason: "a Task has no id",
      file: "flows/a.tsx",
      line: 3,
      suggestion: "name the step"
    }]
  })

  const document = Migrate.document(report)

  expect(document).not.toBeInstanceOf(Report.MigrationReport)
  expect(document).toEqual(JSON.parse(Report.toJson(report)))
})
