import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  testProgram: Smithers.file("//packages/smithers/flows/database/scripts/test-matrix.mjs"),
  deps: [],
  cwd: "packages/smithers/flows/plan-store"
})

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/plan-store",
  checks: [
    {
      id: "plan-integrity-on-admission",
      title: "record and append store only plans that pass Plan.verify with their compiled digests",
      threat:
        "A caller or compromised flow compiler persists a forged plan whose nodes differ from the digest a run's approval binds to.",
      lookFor: [
        "A record or append path that inserts node rows from the caller's plan instead of the value Plan.verify returned.",
        "A record path that answers ExistingSame by comparing digests without first running the verifying get on the stored row.",
        "An append whose compare-and-swap UPDATE omits flow, base_digest, generation - 1, or the verified prefix digest."
      ],
      paths: ["src/PlanStore.ts"]
    },
    {
      id: "plan-read-verification",
      title: "get returns only rows that decode as StoredKey digests and pass Plan.verify",
      threat:
        "Anyone with write access to the SQLite file injects node_json or digest rows that the scheduler then executes as an approved plan.",
      lookFor: [
        "A get path that returns an Option.some plan without decodePlanRow, decodeNode, and verified all succeeding.",
        "Envelope and node rows read by separate statements, letting a concurrent append mix generations in one returned plan.",
        "A decode or integrity failure mapped to Option.none instead of a decode_failed error."
      ],
      paths: ["src/PlanStore.ts"]
    },
    {
      id: "append-only-triggers",
      title: "Schema triggers forbid rewriting or deleting plan, node, and edge rows",
      threat:
        "Code or a direct SQL client rewrites an approved plan's nodes, renames a plan, or rolls back its generation after approval.",
      lookFor: [
        "A migration that drops a flows_plan_* trigger without recreating an equal or stricter one in the same step.",
        "A flows_plans_forward_only WHEN clause missing plan_id, generation, base_digest, flow, or created_at_ms.",
        "A table among flows_plans, flows_plan_nodes, flows_plan_edges lacking a BEFORE UPDATE or BEFORE DELETE rejection.",
        "A migration that drops the flows_plan_nodes_ordinal unique index, letting an inserted row share an ordinal and reorder the plan get returns."
      ],
      paths: ["src/internal/migrations/**", "src/Migrations.ts"]
    },
    {
      id: "sql-parameterization",
      title: "Every SQL statement binds values through the sql tagged template",
      threat: "A plan id, flow name, or node id carrying SQL text alters or reads other plans' rows.",
      lookFor: [
        "sql.unsafe, string concatenation, or template interpolation that builds SQL text from plan fields.",
        "A Dialect.trigger `when` or `reject` value built from runtime input rather than a constant."
      ],
      paths: ["src/**"]
    },
    {
      id: "error-cause-leak",
      title: "PlanStoreError messages and causes carry no node payloads or database credentials",
      threat:
        "A caller surfacing PlanStoreError to a user or log exposes node_json contents or connection details from another plan.",
      lookFor: [
        "An error message that interpolates node_json, node inputs, or a SQL connection string.",
        "A cause attached from a raw driver error that embeds the database path or credentials."
      ],
      paths: ["src/PlanStore.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
