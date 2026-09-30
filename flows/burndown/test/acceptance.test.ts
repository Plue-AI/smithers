import assert from "node:assert/strict"
import test from "node:test"
import {
  completeIssueReceipts,
  parseAcceptanceReview,
  validateAcceptance,
  validateCurrentAcceptance
} from "../acceptance.ts"

const revision = "a".repeat(40)
const context = {
  repo: "smithersai/smithers",
  revision,
  issues: [{ issue: 3116, body: "Acceptance: Separate landing from completion." }],
  checks: "PASS Separate landing from completion regression"
}
function receipt() {
  return {
    version: 1,
    repo: context.repo,
    revision,
    issues: [{
      issue: context.issues[0]!.issue,
      disposition: "complete",
      criteria: [{ criterion: "Separate landing from completion.", evidence: [context.checks] }],
      remaining: []
    }]
  }
}

test("executed acceptance evidence permits completion on the exact checked revision", () => {
  assert.deepEqual(validateAcceptance(receipt(), context), receipt())
})

test("replayed acceptance requires unchanged current issue requirements and complete issue set", () => {
  const record = { context, receipt: validateAcceptance(receipt(), context) }
  assert.doesNotThrow(() => validateCurrentAcceptance(record, context.issues))
  for (
    const issues of [[], [...context.issues, ...context.issues], [{ issue: 1871, body: context.issues[0]!.body }], [{
      issue: 3116,
      body: `${context.issues[0]!.body} Require actual deployment.`
    }]]
  ) {
    assert.throws(() => validateCurrentAcceptance(record, issues), /ACCEPTANCE_CHANGED/)
  }
})

test("final independent review binds structured acceptance to checked evidence", () => {
  assert.deepEqual(
    parseAcceptanceReview(
      `Reviewed complete issue criteria.\nACCEPTANCE ${JSON.stringify(receipt())}\nVERDICT: PASS\n`,
      context
    ),
    {
      context,
      receipt: receipt()
    }
  )
})

test("review failures, missing or duplicated structured output and malformed evidence fail closed", () => {
  const line = `ACCEPTANCE ${JSON.stringify(receipt())}`
  for (
    const report of [
      "VERDICT: PASS",
      `${line}\n${line}\nVERDICT: PASS`,
      "ACCEPTANCE {bad json}\nVERDICT: PASS",
      `${line}\nVERDICT: FAIL`,
      `${line}\nVERDICT: FAIL\nVERDICT: PASS`,
      `${line}\nVERDICT: PASS\nunreviewed tail`,
      `${line}\nprovider capacity exhausted`,
      `capacity exhausted\nVERDICT: FAIL\n${line}\nVERDICT: PASS`,
      `ACCEPTANCE ${JSON.stringify({ ...receipt(), revision: "c".repeat(40) })}\nVERDICT: PASS`
    ]
  ) assert.throws(() => parseAcceptanceReview(report, context))
})

test("partial native tool identity lands while its acceptance issue stays open", () => {
  const partial = {
    ...receipt(),
    issues: [{
      issue: 1871,
      disposition: "landed",
      criteria: [],
      remaining: [{
        issue: "smithersai/smithers#1871",
        condition: "Complete native tool content identities before enabling default caching."
      }]
    }]
  }
  assert.deepEqual(
    validateAcceptance(partial, {
      ...context,
      issues: [{
        issue: 1871,
        body: "Enable default caching with complete native tool identity."
      }],
      checks: "Cloud pipeline PASS; docs retain noncacheable defaults."
    }),
    partial
  )
})

test("mixed issue dispositions retain a concrete prerequisite without completing its dependent acceptance", () => {
  const mixed = receipt()
  const dependency = {
    issue: 3098,
    disposition: "landed",
    criteria: [{ criterion: "Go prerequisite passes.", evidence: ["Go prerequisite PASS"] }],
    remaining: [{ issue: "smithersai/smithers#3097", condition: "Finish model price and provenance docs acceptance." }]
  }
  const value = { ...mixed, issues: [...mixed.issues, dependency] }
  assert.deepEqual(
    validateAcceptance(value, {
      ...context,
      issues: [...context.issues, {
        issue: dependency.issue,
        body: "Go prerequisite passes. Full docs acceptance depends on #3097."
      }],
      checks: `${context.checks}\nGo prerequisite PASS`
    }),
    value
  )
})

test("absent and malformed receipts fail closed", () => {
  for (const value of [undefined, null, true, [], {}, "VERDICT PASS"]) {
    assert.throws(() => validateAcceptance(value, context))
  }
  for (const field of ["issues", "criteria", "evidence", "remaining"]) {
    const item = receipt().issues[0]!
    const invalid = field === "issues" ? { ...receipt(), issues: null } : {
      ...receipt(),
      issues: [{
        ...item,
        ...(field === "evidence" ?
          {
            criteria: [{ ...item.criteria[0]!, evidence: null }]
          } :
          { [field]: null })
      }]
    }
    assert.throws(() => validateAcceptance(invalid, context))
  }
})

test("source issue identities must be positive integers rather than coerced strings", () => {
  for (const issue of ["3116", 0, -1, 1.5, Number.NaN]) {
    assert.throws(() =>
      validateAcceptance(receipt(), {
        ...context,
        issues: [{ issue: issue as number, body: context.issues[0]!.body }]
      })
    )
    assert.throws(() => validateAcceptance({ ...receipt(), issues: [{ ...receipt().issues[0]!, issue }] }, context))
  }
})

test("wrong repository, revision, version and issue sets fail closed", () => {
  for (
    const changes of [
      { version: 2 },
      { repo: "other/repository" },
      { revision: "b".repeat(40) },
      { revision: "a".repeat(39) },
      { issues: [] },
      { issues: [...receipt().issues, ...receipt().issues] },
      { issues: [{ ...receipt().issues[0]!, issue: 1871 }] }
    ]
  ) assert.throws(() => validateAcceptance({ ...receipt(), ...changes }, context))
})

test("completion requires criteria from the real issue and verbatim executed evidence", () => {
  for (
    const criteria of [
      [],
      [{ criterion: "", evidence: [context.checks] }],
      [{ criterion: "Invented reduced scope", evidence: [context.checks] }],
      [{ criterion: "Separate landing from completion.", evidence: [] }],
      [{ criterion: "Separate landing from completion.", evidence: ["Invented PASS"] }],
      [{ criterion: "Separate landing from completion.", evidence: [""] }]
    ]
  ) assert.throws(() => validateAcceptance({ ...receipt(), issues: [{ ...receipt().issues[0]!, criteria }] }, context))
})

test("failed checks cannot be used as successful completion evidence", () => {
  for (
    const failure of [
      "CHECK_FAILED regression",
      "CHECK_TIMEOUT",
      "CHECK_RED_END",
      "VERDICT FAIL",
      "NO_VERIFICATION",
      "docs retain noncacheable defaults",
      "requirement remains pending",
      "deployment not executed",
      "blocked by #3097"
    ]
  ) {
    const value = receipt()
    value.issues[0]!.criteria[0]!.evidence = [failure]
    assert.throws(() => validateAcceptance(value, { ...context, checks: failure }))
  }
})

test("missing executed checks and duplicate source issues cannot yield completion", () => {
  assert.throws(() => validateAcceptance(receipt(), { ...context, checks: "" }))
  assert.throws(() => validateAcceptance(receipt(), { ...context, issues: [...context.issues, ...context.issues] }))
})

test("matching but invalid repository and revision contexts remain invalid", () => {
  for (const repo of ["smithers", "smithersai/smithers/extra", " smithersai/smithers"]) {
    assert.throws(() => validateAcceptance({ ...receipt(), repo }, { ...context, repo }))
  }
  for (const revision of ["a".repeat(39), "A".repeat(40)]) {
    assert.throws(() => validateAcceptance({ ...receipt(), revision }, { ...context, revision }))
  }
  assert.throws(() => validateAcceptance({ ...receipt(), issues: [] }, { ...context, issues: [] }))
})

test("complete cannot retain unresolved requirements and landed cannot omit them", () => {
  const issue = receipt().issues[0]!
  assert.throws(() =>
    validateAcceptance({
      ...receipt(),
      issues: [{
        ...issue,
        remaining: [{ issue: `smithersai/smithers#${issue.issue}`, condition: "Still needs deployment." }]
      }]
    }, context)
  )
  assert.throws(() => validateAcceptance({ ...receipt(), issues: [{ ...issue, disposition: "landed" }] }, context))
  assert.throws(() => validateAcceptance({ ...receipt(), issues: [{ ...issue, disposition: "ready" }] }, context))
})

test("remainders must link a real issue identity and state the remaining condition", () => {
  for (
    const remaining of [
      [{ issue: "#3097", condition: "Finish docs." }],
      [{ issue: "smithersai/smithers#0", condition: "Finish docs." }],
      [{ issue: "smithersai/smithers#3097", condition: " " }],
      [{ issue: "smithersai/smithers#3097" }]
    ]
  ) {
    assert.throws(() =>
      validateAcceptance(
        { ...receipt(), issues: [{ ...receipt().issues[0]!, disposition: "landed", remaining }] },
        context
      )
    )
  }
})

function mixedLanding() {
  const mixedContext = {
    ...context,
    issues: [...context.issues, { issue: 3098, body: "Full docs acceptance depends on #3097." }]
  }
  return {
    member: { repo: context.repo, key: "acceptance-test" },
    landed: [{ issue: 3116, sha: "b".repeat(40) }, { issue: 3098, sha: revision }],
    acceptance: {
      context: mixedContext,
      receipt: validateAcceptance({
        ...receipt(),
        issues: [...receipt().issues, {
          issue: 3098,
          disposition: "landed",
          criteria: [],
          remaining: [{ issue: "smithersai/smithers#3097", condition: "Finish docs acceptance." }]
        }]
      }, mixedContext)
    }
  }
}

test("receipt delivery closes only complete issues and releases every landed claim with honest evidence", async () => {
  const { member, landed, acceptance } = mixedLanding()
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
  await completeIssueReceipts(member, landed, acceptance, async (command, args) => {
    if (args.includes("check")) return { stdout: JSON.stringify({ mine: true }) }
    calls.push({ command, args })
  })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.command, "node")
    assert.ok(call.args.includes("comment"))
    assert.ok(call.args.includes("--release"))
    assert.ok(call.args.includes("burndown-acceptance-test"))
  }
  assert.ok(calls[0]!.args.includes("--close"))
  assert.ok(!calls[1]!.args.includes("--close"))
  const completeBody = calls[0]!.args[calls[0]!.args.indexOf("--body") + 1]
  const landedBody = calls[1]!.args[calls[1]!.args.indexOf("--body") + 1]
  assert.ok(completeBody!.includes("Separate landing from completion."))
  assert.ok(completeBody!.includes(context.checks))
  assert.ok(landedBody!.includes("smithersai/smithers#3097"))
  assert.ok(landedBody!.includes("Finish docs acceptance."))
})

test("absent or unbound post-push acceptance refuses every issue mutation", async () => {
  const { member, landed, acceptance } = mixedLanding()
  for (
    const invalid of [
      undefined,
      null,
      { ...acceptance, receipt: { ...acceptance.receipt, revision: "c".repeat(40) } },
      { ...acceptance, receipt: { ...acceptance.receipt, issues: acceptance.receipt.issues.slice(0, 1) } },
      { ...acceptance, receipt: { ...acceptance.receipt, repo: "other/repo" } },
      { ...acceptance, context: { ...acceptance.context, checks: "CHECK_FAILED" } }
    ]
  ) {
    let calls = 0
    await assert.rejects(() =>
      completeIssueReceipts(member, landed, invalid as typeof acceptance, async () => {
        calls++
      })
    )
    assert.equal(calls, 0)
  }
})

test("receipt failures attempt all issues and replay preserves their dispositions without another push", async () => {
  const { member, landed, acceptance } = mixedLanding()
  const failedCalls: Array<ReadonlyArray<string>> = []
  await assert.rejects(() =>
    completeIssueReceipts(member, landed, acceptance, async (_command, args) => {
      if (args.includes("check")) return { stdout: JSON.stringify({ mine: true }) }
      failedCalls.push(args)
      if (args.includes("smithersai/smithers#3116")) throw new Error("provider unavailable")
    }), /LANDING_RECEIPTS_FAILED/)
  assert.equal(failedCalls.length, 2)
  const replayCalls: Array<ReadonlyArray<string>> = []
  await completeIssueReceipts(member, landed, acceptance, async (command, args) => {
    if (args.includes("check")) return { stdout: JSON.stringify({ mine: true }) }
    assert.equal(command, "node")
    assert.ok(!args.includes("push"))
    replayCalls.push(args)
  })
  assert.deepEqual(replayCalls, failedCalls)
})

test("duplicate or malformed pushed revisions refuse mutations before delivery", async () => {
  const { member, landed, acceptance } = mixedLanding()
  for (
    const invalid of [[], [...landed, landed[0]!], [{ ...landed[0]!, sha: "short" }, landed[1]!], [{
      ...landed[0]!,
      issue: 1871
    }, landed[1]!]]
  ) {
    let calls = 0
    await assert.rejects(() =>
      completeIssueReceipts(member, invalid, acceptance, async () => {
        calls++
      })
    )
    assert.equal(calls, 0)
  }
})

test("landed prerequisite receipts include executed evidence and retain provider diagnostics", async () => {
  const { member, landed, acceptance } = mixedLanding()
  acceptance.context.issues[1]!.body += " Go prerequisite passes."
  acceptance.context.checks += "\nGo prerequisite PASS"
  const record = {
    ...acceptance,
    receipt: {
      ...acceptance.receipt,
      issues: acceptance.receipt.issues.map((item) =>
        item.issue === 3098 ?
          {
            ...item,
            criteria: [{ criterion: "Go prerequisite passes.", evidence: ["Go prerequisite PASS"] }]
          } :
          item
      )
    }
  }
  const diagnostics = { stdout: "provider stdout", stderr: "provider stderr", message: "delivery failed" }
  await assert.rejects(() =>
    completeIssueReceipts(member, landed, record, async (_command, args) => {
      if (args.includes("check")) return { stdout: JSON.stringify({ mine: true }) }
      if (args.includes("smithersai/smithers#3098")) {
        const body = args[args.indexOf("--body") + 1]!
        assert.ok(body.includes("Go prerequisite passes."))
        assert.ok(body.includes("Go prerequisite PASS"))
        assert.ok(!args.includes("--close"))
        throw diagnostics
      }
    }), /provider stdout provider stderr delivery failed/)
})

test("non-Error provider rejection remains visible in the durable receipt failure", async () => {
  const { member, landed, acceptance } = mixedLanding()
  await assert.rejects(() =>
    completeIssueReceipts(member, landed, acceptance, async () => {
      throw "provider denied"
    }), /provider denied/)
})

test("foreign ownership blocks issue mutation while other landed issues still receive receipts", async () => {
  const { member, landed, acceptance } = mixedLanding()
  const comments: Array<ReadonlyArray<string>> = []
  await assert.rejects(() =>
    completeIssueReceipts(member, landed, acceptance, async (_command, args) => {
      if (args.includes("check")) {
        return {
          stdout: JSON.stringify(
            args.includes("smithersai/smithers#3116") ?
              { mine: false, free: false, holder: { by: "another-agent", expired: true } } :
              { mine: true }
          )
        }
      }
      comments.push(args)
    }), /CLAIM|OWNERSHIP/)
  assert.equal(comments.length, 1)
  assert.ok(comments[0]!.includes("smithersai/smithers#3098"))
})

test("released-claim replay can finish receipt delivery without releasing another claim", async () => {
  const { member, landed, acceptance } = mixedLanding()
  const comments: Array<ReadonlyArray<string>> = []
  await completeIssueReceipts(member, landed, acceptance, async (_command, args) => {
    if (args.includes("check")) return { stdout: JSON.stringify({ mine: false, free: true, holder: null }) }
    comments.push(args)
  })
  assert.equal(comments.length, 2)
  assert.ok(comments.every((args) => !args.includes("--release")))
  assert.ok(comments[0]!.includes("--close"))
  assert.ok(!comments[1]!.includes("--close"))
})

test("unknown or malformed ownership evidence cannot authorize issue comment or closure", async () => {
  const { member, landed, acceptance } = mixedLanding()
  for (
    const stdout of [
      "not json",
      "{}",
      "null",
      JSON.stringify({ mine: false, free: false }),
      JSON.stringify({ free: true, holder: null }),
      JSON.stringify({ mine: false, free: true, holder: false }),
      JSON.stringify({ mine: false, free: true, holder: 0 })
    ]
  ) {
    let comments = 0
    await assert.rejects(() =>
      completeIssueReceipts(member, landed, acceptance, async (_command, args) => {
        if (args.includes("check")) return { stdout }
        comments++
      })
    )
    assert.equal(comments, 0)
  }
})

test("null provider rejection remains visible without interrupting remaining receipt attempts", async () => {
  const { member, landed, acceptance } = mixedLanding()
  let comments = 0
  await assert.rejects(() =>
    completeIssueReceipts(member, landed, acceptance, async (_command, args) => {
      if (args.includes("check")) return { stdout: JSON.stringify({ mine: true }) }
      comments++
      throw null
    }), /LANDING_RECEIPTS_FAILED[\s\S]*null/)
  assert.equal(comments, 2)
})
