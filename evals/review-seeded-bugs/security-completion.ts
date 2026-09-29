/** Live SecurityReview evaluation over vulnerable/fixed SQL fixture pairs. */
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Input from "../../packages/smithers/build/targets/src/Input.ts"
import * as LlmLint from "../../packages/smithers/build/targets/src/LlmLint.ts"
import { materializeFixture } from "./fixtureRepo.ts"
import { scoreSecurity, type SecurityObservation } from "./security-completion-score.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const repeats = Number(process.argv[2] ?? "3")
const output = resolve(process.argv[3] ?? "security-completion-report.json")
if (!Number.isSafeInteger(repeats) || repeats < 2 || repeats > 20) {
  throw new Error("Usage: node security-completion.ts <repeats:2..20> <report.json>")
}
const startedAt = new Date().toISOString()
const observations: Array<SecurityObservation> = []
const receipts: Array<unknown> = []
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim()
const implementationSha256 = createHash("sha256").update(
  await readFile(
    new URL("../../packages/smithers/build/targets/src/LlmLint.ts", import.meta.url)
  )
).digest("hex")

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const fixture of ["sql-injection", "sql-injection-like"]) {
    for (const vulnerable of [true, false]) {
      const work = await mkdtemp(join(tmpdir(), "security-eval-"))
      try {
        const corpus = join(directory, "corpus", fixture)
        const root = materializeFixture(corpus, work)
        const file = fixture === "sql-injection" ? "src/users.ts" : "src/search.ts"
        if (!vulnerable) await copyFile(join(corpus, "base", file), join(root, file))
        const source = await readFile(join(root, file), "utf8")
        // Controlled execution uses an in-memory real SQLite database and synthetic rows only.
        const db = new DatabaseSync(":memory:")
        let reproduction: { observedRows: number; expectedRows: number }
        try {
          db.exec(
            "CREATE TABLE users(id TEXT, email TEXT); INSERT INTO users VALUES ('private','secret');" +
              "CREATE TABLE articles(id TEXT, title TEXT); INSERT INTO articles VALUES ('private','secret');"
          )
          const module = await import(pathToFileURL(join(root, file)).href)
          const query = async (sql: string, params: Array<string> = []) => db.prepare(sql).all(...params)
          const result = fixture === "sql-injection"
            ? await module.findUserByEmail({ query }, "' OR 1=1 --")
            : await module.searchArticles({ query }, "' OR 1=1 --")
          reproduction = {
            observedRows: Array.isArray(result) ? result.length : result === null ? 0 : 1,
            expectedRows: vulnerable ? 1 : 0
          }
          if (reproduction.observedRows !== reproduction.expectedRows) throw new Error("fixture reproduction drift")
        } finally {
          db.close()
        }
        const result = await Effect.runPromise(
          LlmLint.review({ workspaceRoot: root, timeoutMs: 60_000 }, {
            base: "HEAD",
            scope: "all",
            include: [Input.glob("src/**")],
            context: [],
            prompt: "Authorized defensive review of synthetic local fixtures. Inspect SQL injection.",
            rubric: "Check sql-injection for untrusted input in SQL and general for other security defects.",
            securityChecks: ["sql-injection", "general"],
            engine: "claude",
            model: "claude-opus-5-5",
            batchSize: 4,
            failOn: "error"
          }).pipe(Effect.result)
        )
        const report = result._tag === "Success" ? result.success : result.failure
        const findings = "findings" in report ? report.findings : []
        const attempts = "attempts" in report ? report.attempts ?? [] : []
        // Only candidates anchored to the reproduced SQL sink are confirmed; others remain unconfirmed.
        const reproduced = vulnerable && reproduction.observedRows > 0 ?
          findings.filter((finding) =>
            finding.file === file && Math.abs(finding.line - 7) <= 2 && finding.security?.checkId === "sql-injection"
          ).length :
          0
        observations.push({
          repeat,
          fixture,
          vulnerable,
          completed: result._tag === "Success" || report instanceof LlmLint.FindingsError,
          refused: attempts.some((attempt) =>
            attempt.completion?.status === "refused" ||
            /refus|cannot assist|can't assist|cannot help|can't help/i.test(attempt.message)
          ),
          candidates: findings.length,
          reproduced
        })
        receipts.push({
          repeat,
          fixture,
          vulnerable,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
          reproduction,
          report
        })
        await writeFile(
          output,
          JSON.stringify(
            {
              revision,
              implementationSha256,
              startedAt,
              repeats,
              methodology:
                "Two SQL injection pairs, real SQLite reproduction; candidate match by check and sink line ±2; " +
                "unmatched candidates remain unconfirmed. Population variance across repeats. No general recall claim.",
              observations,
              score: scoreSecurity(observations),
              receipts
            },
            null,
            2
          ) + "\n"
        )
        process.stdout.write(
          `${repeat + 1}/${repeats} ${fixture} ${vulnerable ? "vulnerable" : "fixed"}: ` +
            `${result._tag}, reproduced=${reproduced}\n`
        )
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }
  }
}
