import type { ControlSchema } from "@smthrs/control"
import * as Diagnosis from "@smthrs/gateway/Diagnosis"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Forensics from "../src/Forensics.ts"

const staged: Array<string> = []

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

const unblockCommand = (card: string): string => {
  const prefix = "Unblock   "
  const start = card.indexOf(prefix)
  const end = card.indexOf("\nNext      ", start)
  if (start < 0 || end < 0) throw new Error("diagnosis did not contain an unblock command")
  return card.slice(start + prefix.length, end)
}

/**
 * The executable a rendered command names: its first shell word.
 *
 * The recording shim is written under that name rather than a spelling this
 * file repeats, because the two have to be the same word for the shim to
 * shadow anything. They were not: the card renders `smthrs` and the shim was
 * written as `smithers`, so `/bin/sh` resolved the real CLI off `PATH` and
 * each case booted the control plane for minutes before failing on a run id
 * that does not exist.
 */
const executableOf = (command: string): string => {
  const name = command.trimStart().split(/\s/)[0] ?? ""
  if (!/^[\w.-]+$/.test(name)) {
    throw new Error(`the unblock command does not start with a bare executable: ${command}`)
  }
  return name
}

const recordArguments = (command: string): ReadonlyArray<ReadonlyArray<string>> => {
  const root = mkdtempSync(join(tmpdir(), "smithers-forensics-"))
  staged.push(root)
  const name = executableOf(command)
  const executable = join(root, name)
  const record = join(root, "argv.jsonl")
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
appendFileSync(process.env.SMITHERS_ARGV_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n")
`,
    { encoding: "utf8", mode: 0o755 }
  )
  writeFileSync(record, "", "utf8")

  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    SMITHERS_ARGV_RECORD: record
  }

  // What the shell will actually run, asserted before it runs it. Without
  // this the only symptom of a shim that shadows nothing is a real CLI boot
  // per invocation, which reads as a slow suite rather than as this defect.
  const resolved = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", env, timeout: 30_000 })
    .trim()
  if (resolved !== executable) {
    throw new Error(`PATH resolves ${name} to ${resolved}, not the recording shim at ${executable}`)
  }

  // The shim is a two-line script, so a run that reaches half a minute is a
  // process this test did not mean to start.
  execFileSync("/bin/sh", ["-c", command], { env, timeout: 30_000 })

  return readFileSync(record, "utf8").trim().split("\n").filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ReadonlyArray<string>)
}

/** Builds one watch delta with the fields the projections read. */
const event = (
  kind: string,
  payload: unknown,
  occurredAt = 1_000
): ControlSchema.ControlEvent => ({
  sequence: occurredAt,
  kind,
  runId: "run-1" as ControlSchema.ControlEvent["runId"],
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

const turn = (at: number) => event("control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", at }, at)

const call = (flowName: string, input: unknown, at: number) =>
  event("control.agent.cell-call-started", { flowName, input, at }, at)

const settledCall = (flowName: string, at: number) =>
  event("control.agent.cell-call-settled", { flowName, outcome: "success", value: null, at }, at)

const refusedCall = (message: string, at: number) =>
  event("control.agent.cell-call-settled", { flowName: "bash", outcome: "failure", message, at }, at)

describe("Forensics.digest", () => {
  it("counts turns, calls, refusals, duplicates, and edits", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1", status: "running" }, 0),
      turn(1_000),
      call("bash", { command: "ls" }, 2_000),
      refusedCall("Flow bash failed: refused once", 3_000),
      turn(4_000),
      call("bash", { command: "ls" }, 5_000),
      settledCall("bash", 6_000),
      call("edit", { path: "a.py" }, 7_000),
      settledCall("edit", 8_000),
      event("control.run.completed", { runId: "run-1", status: "completed" }, 9_000)
    ])
    expect(d.turns).toBe(2)
    expect(d.calls).toBe(3)
    expect(d.callsFailed).toBe(1)
    // The second `bash {command:"ls"}` is byte-identical to the first.
    expect(d.duplicateCalls).toBe(1)
    expect(d.editsAttempted).toBe(1)
    expect(d.editsSucceeded).toBe(1)
    expect(d.status).toBe("completed")
    expect(d.refusals).toEqual([{ message: "Flow bash failed: refused once", count: 1 }])
    expect(d.flows[0]).toEqual(["bash", 2])
  })

  it("sums usage tokens and keeps the recorded failure cause", () => {
    const d = Forensics.digest([
      turn(0),
      event("control.agent.model-settled", { text: "x", usage: { inputTokens: 100, outputTokens: 7 } }, 1),
      event("control.agent.model-settled", { text: "y", usage: { inputTokens: 50, outputTokens: 3 } }, 2),
      event("control.run.failed", { runId: "run-1", status: "failed", cause: "boom\nstack" }, 3)
    ])
    expect(d.inputTokens).toBe(150)
    expect(d.outputTokens).toBe(10)
    expect(d.status).toBe("failed")
    expect(d.cause).toBe("boom\nstack")
  })

  it("prefers the payload's own occurrence stamp over journal admission time", () => {
    const d = Forensics.digest([
      event("control.agent.turn-opened", { seat: "s", at: 10 }, 5_000),
      event("control.agent.resolved", { text: "done", at: 4_010 }, 5_000)
    ])
    expect(d.startedAt).toBe(10)
    expect(d.endedAt).toBe(4_010)
  })

  it("captures the parked ask and its approval payload", () => {
    const d = Forensics.digest([
      event("control.approval.requested", {
        question: "May I?",
        payload: { idempotencyKey: "approve:x", scope: "run" }
      }, 1),
      event("control.run.waiting-approval", { runId: "run-1", status: "waiting-approval" }, 2)
    ])
    expect(d.parkedQuestion).toBe("May I?")
    expect(d.parkedApproval).toBe(JSON.stringify({ idempotencyKey: "approve:x", scope: "run" }))
  })

  it("is total over malformed payloads", () => {
    const d = Forensics.digest([
      event("control.agent.model-settled", null, 1),
      event("control.agent.cell-call-started", "not-an-object", 2),
      event("control.agent.cell-call-settled", 7, 3)
    ])
    expect(d.calls).toBe(1)
    expect(d.flows).toEqual([["?", 1]])
    expect(d.inputTokens).toBe(0)
  })
})

describe("Forensics.renderDiagnosis", () => {
  it("shows the nested provider refusal from an older recorded stack", () => {
    const cause =
      "/harness/HarnessError: The cell frame failed\n    at harness.ts:1\n  [cause]: flows/model/ModelError: Add credits to continue.\n    at model.ts:1"
    const d = Forensics.digest([event("control.run.failed", { cause }, 1)])
    expect(d.cause).toBe(cause)
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("Verdict   failed: flows/model/ModelError: Add credits to continue.")
    expect(card).not.toContain("The cell frame failed")
  })

  it("names the failure cause in the verdict", () => {
    const d = Forensics.digest([
      turn(0),
      event("control.run.failed", { runId: "run-1", status: "failed", cause: "TransportError: gone" }, 1)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1", flowId: "fix" }, d)
    expect(card).toContain("Verdict   failed: TransportError: gone")
    expect(card).toContain("run-1 · fix")
    expect(card).toContain("Next      smthrs runs logs run-1")
  })

  it("calls out a completed run that never attempted an edit", () => {
    const d = Forensics.digest([
      turn(0),
      call("read", { path: "a" }, 1),
      settledCall("read", 2),
      event("control.run.completed", { runId: "run-1", status: "completed" }, 3)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d))
      .toContain("completed: but 0 of 1 calls attempted an edit")
  })

  it("names a drifted run's recorded and current code and the resume that accepts it", () => {
    const d = Forensics.digest([event("control.run.parked", { runId: "run-1", status: "parked" }, 1)])
    const card = Forensics.renderDiagnosis({
      runId: "run-1",
      codeDrift: { recorded: "sha-a", current: "sha-b", recordedEngine: "1.0.0", currentEngine: "1.1.0" }
    }, d)
    expect(card).toContain(
      "Drift     flow sha-a → sha-b, engine 1.0.0 → 1.1.0    # resume needs smthrs runs resume run-1 --allow-code-drift"
    )
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).not.toContain("Drift")
  })

  it("prints the exact unblock command for a parked run", () => {
    const d = Forensics.digest([
      event("control.approval.requested", { question: "Q", payload: { k: 1 } }, 1),
      event("control.run.waiting-approval", { runId: "run-1", status: "waiting-approval" }, 2)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("waiting-approval: asks: Q")
    // The payload is quoted because it carries braces and quotes; the verbs,
    // the flag, and the run id are not, because a shell reads nothing in them.
    expect(card).toContain(
      `Unblock   smthrs approvals approve '{"k":1}' --scope run && smthrs runs resume run-1`
    )
  })

  it("passes hostile approval text and run ids as their exact argv elements", () => {
    const approval = "apostrophe '\n$(printf substituted)\n`printf substituted`"
    const runId = "run-'id\n$(printf changed)\n`printf changed`"
    const d: Forensics.Digest = {
      ...Forensics.digest([]),
      status: "waiting-approval",
      parkedApproval: approval
    }

    const recorded = recordArguments(unblockCommand(Forensics.renderDiagnosis({ runId }, d)))

    expect(recorded).toEqual([
      ["approvals", "approve", approval, "--scope", "run"],
      ["runs", "resume", runId]
    ])
  })

  it("passes a pending run id as one exact cancel argument", () => {
    const runId = "run-'id\n$(printf changed)\n`printf changed`"
    const d: Forensics.Digest = { ...Forensics.digest([]), status: "pending" }

    const recorded = recordArguments(unblockCommand(Forensics.renderDiagnosis({ runId }, d)))

    expect(recorded).toEqual([["runs", "cancel", runId]])
  })

  it("quotes one POSIX shell word with the standard apostrophe escape", () => {
    expect(Forensics.shellQuote("")).toBe("''")
    expect(Forensics.shellQuote("a'b\n$(x)`y`")).toBe("'a'\\''b\n$(x)`y`'")
  })

  it("leaves a word no shell interprets unquoted", () => {
    // The card is copied by hand, and quoting `'smithers' 'cancel' 'run-1'`
    // makes an operator wonder what the quotes mean. Ordinary run ids, verbs,
    // flags, and paths carry nothing a shell reads, so they render as typed.
    for (const inert of ["smithers", "cancel", "run-1", "--scope", "flows/hello", "a.b_c@d%e+f=g:h,i"]) {
      expect(Forensics.shellQuote(inert)).toBe(inert)
    }
    // Anything outside that set is still one quoted word, including a space.
    for (const quoted of ["", "a b", "a;b", "a|b", "$x", "a\tb", "a\nb", "*", "~", "#c", "(x)"]) {
      expect(Forensics.shellQuote(quoted)).toBe(`'${quoted.replaceAll("'", "'\\''")}'`)
    }
  })

  it("advertises the cancel line an operator would have typed", () => {
    const d: Forensics.Digest = { ...Forensics.digest([]), status: "pending" }

    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).toContain("smthrs runs cancel run-1")
  })

  it("lists the top refusals with counts, largest first", () => {
    const d = Forensics.digest([
      turn(0),
      refusedCall("first refusal", 1),
      refusedCall("second refusal", 2),
      refusedCall("second refusal", 3)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("Refusals  2× second refusal")
    expect(card).toContain("1× first refusal")
  })
})

describe("Forensics.renderTranscript", () => {
  it("renders a turn header and one line per event", () => {
    const text = Forensics.renderTranscript([
      event("control.run.running", { runId: "run-1", status: "running", at: 0 }, 0),
      turn(1_000),
      event("control.agent.model-settled", {
        text: "```cell\nreturn 1\n```",
        usage: { inputTokens: 9, outputTokens: 2 },
        at: 2_000
      }, 2_000),
      call("bash", { command: "echo hi" }, 3_000),
      refusedCall("Flow bash failed: nope", 4_000),
      event("control.agent.transition-applied", {
        transition: { _tag: "complete", state: {}, output: "done" },
        at: 5_000
      }, 5_000),
      event("control.run.completed", { runId: "run-1", status: "completed", at: 6_000 }, 6_000)
    ])
    expect(text).toContain("run-1 · completed")
    expect(text).toContain("=== turn 1 · openai:gpt-5.6-sol ===")
    expect(text).toContain("call    bash {\"command\":\"echo hi\"}")
    expect(text).toContain("-> FAIL Flow bash failed: nope")
    expect(text).toContain("complete done")
    expect(text).toContain("[+00:06] run.completed")
  })

  it("renders the empty journal as a sentence, not a crash", () => {
    expect(Forensics.renderTranscript([])).toBe("No events.")
  })
})

describe("Forensics.digest boundaries", () => {
  it("keeps the last named seat when a later turn opens without one", () => {
    const d = Forensics.digest([
      event("control.agent.turn-opened", { seat: "anthropic:claude-sonnet-4-5" }, 1),
      event("control.agent.turn-opened", {}, 2)
    ])
    expect(d.turns).toBe(2)
    expect(d.seat).toBe("anthropic:claude-sonnet-4-5")
  })

  it("names an unlabelled refusal rather than dropping it", () => {
    const d = Forensics.digest([event("control.agent.cell-call-settled", { outcome: "failure" }, 1)])
    expect(d.callsFailed).toBe(1)
    expect(d.refusals).toEqual([{ message: "unknown refusal", count: 1 }])
  })

  it("records a park with no serialized approval as having none", () => {
    const d = Forensics.digest([event("control.approval.requested", { question: "May I?" }, 1)])
    expect(d.parkedQuestion).toBe("May I?")
    expect(d.parkedApproval).toBeUndefined()
  })

  it("digests the empty journal as a zeroed, unlaunched digest", () => {
    expect(Forensics.digest([])).toEqual({
      status: undefined,
      cause: undefined,
      seat: undefined,
      turns: 0,
      calls: 0,
      callsFailed: 0,
      duplicateCalls: 0,
      editsAttempted: 0,
      editsSucceeded: 0,
      flows: [],
      refusals: [],
      inputTokens: 0,
      outputTokens: 0,
      finalOutput: undefined,
      parkedQuestion: undefined,
      parkedApproval: undefined,
      startedAt: undefined,
      endedAt: undefined
    })
  })

  it("counts the third identical call as a second duplicate", () => {
    const d = Forensics.digest([
      call("read", { path: "a" }, 1),
      call("read", { path: "a" }, 2),
      call("read", { path: "a" }, 3),
      call("read", { path: "b" }, 4)
    ])
    expect(d.calls).toBe(4)
    expect(d.duplicateCalls).toBe(2)
  })

  it("ignores redelivered call IDs while counting distinct calls with identical inputs", () => {
    const first = { flowName: "write", input: { path: "a" }, callId: "first" }
    const second = { ...first, callId: "second" }
    const failure = { flowName: "write", callId: "second", outcome: "failure", message: "denied" }
    const success = { flowName: "write", callId: "first", outcome: "success" }
    const d = Forensics.digest([
      event("control.agent.cell-call-started", first, 1),
      event("control.agent.cell-call-started", second, 2),
      event("control.agent.cell-call-started", first, 3),
      event("control.agent.cell-call-settled", failure, 4),
      event("control.agent.cell-call-settled", success, 5),
      event("control.agent.cell-call-settled", failure, 6),
      event("control.agent.cell-call-settled", success, 7)
    ])
    expect(d).toMatchObject({
      calls: 2,
      callsFailed: 1,
      duplicateCalls: 1,
      editsAttempted: 2,
      editsSucceeded: 1,
      flows: [["write", 2]],
      refusals: [{ message: "denied", count: 1 }]
    })
  })

  it("counts every edit flow name and no other", () => {
    const d = Forensics.digest([
      call("write", {}, 1),
      settledCall("write", 2),
      call("edit", {}, 3),
      settledCall("edit", 4),
      call("apply_patch", {}, 5),
      settledCall("apply_patch", 6),
      call("read", {}, 7),
      settledCall("read", 8)
    ])
    expect(d.editsAttempted).toBe(3)
    expect(d.editsSucceeded).toBe(3)
  })

  it("does not credit a failed edit as a successful one", () => {
    const d = Forensics.digest([
      call("edit", {}, 1),
      event("control.agent.cell-call-settled", { flowName: "edit", outcome: "failure", message: "denied" }, 2)
    ])
    expect(d.editsAttempted).toBe(1)
    expect(d.editsSucceeded).toBe(0)
    expect(d.callsFailed).toBe(1)
  })

  it("keeps the last transition of each kind when a run transitions twice", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1" }, 1),
      event("control.run.failed", { runId: "run-1", cause: "first" }, 2),
      event("control.run.completed", { runId: "run-1" }, 3)
    ])
    // The status is the last transition seen; the cause is only read on the
    // transition that recorded it, so a later status does not erase it.
    expect(d.status).toBe("completed")
    expect(d.cause).toBe("first")
  })
})

describe("Forensics.eventLine", () => {
  it.each(
    [
      [
        "a seated turn",
        "control.agent.turn-opened",
        { seat: "openai:gpt-5.6-sol" },
        "turn opened · openai:gpt-5.6-sol"
      ],
      ["an unseated turn", "control.agent.turn-opened", {}, "turn opened · "],
      [
        "a model reply",
        "control.agent.model-settled",
        { text: "hello\nworld", usage: { inputTokens: 9, outputTokens: 2 } },
        "model   hello (9 in / 2 out)"
      ],
      ["a model reply with no usage", "control.agent.model-settled", {}, "model    (0 in / 0 out)"],
      ["a cell", "control.agent.cell-produced", { text: "return 1" }, "cell    return 1"],
      ["an empty cell", "control.agent.cell-produced", {}, "cell    "],
      [
        "a call",
        "control.agent.cell-call-started",
        { flowName: "bash", input: { command: "ls" } },
        "call    bash {\"command\":\"ls\"}"
      ],
      ["an unnamed call", "control.agent.cell-call-started", {}, "call    ? undefined"],
      [
        "a successful call",
        "control.agent.cell-call-settled",
        { outcome: "success", value: { ok: true } },
        "  -> ok {\"ok\":true}"
      ],
      [
        "a refused call",
        "control.agent.cell-call-settled",
        { outcome: "failure", message: "denied" },
        "  -> FAIL denied"
      ],
      ["an unlabelled refusal", "control.agent.cell-call-settled", { outcome: "failure" }, "  -> FAIL "],
      [
        "a completing transition",
        "control.agent.transition-applied",
        { transition: { _tag: "complete", output: "done" } },
        "complete done"
      ],
      [
        "a completing transition with no output",
        "control.agent.transition-applied",
        { transition: { _tag: "complete" } },
        "complete "
      ],
      [
        "a parking transition",
        "control.agent.transition-applied",
        { transition: { _tag: "park", reason: "approval", message: "May I?" } },
        "park (approval) May I?"
      ],
      [
        "a parking transition with neither reason nor message",
        "control.agent.transition-applied",
        { transition: { _tag: "park" } },
        "park (?) "
      ],
      [
        "a continuing transition from a wave that filed",
        "control.agent.transition-applied",
        { transition: { _tag: "continue", context: [1], state: { a: 1 } } },
        "continue · filed state 7B · context 3B"
      ],
      [
        "a continuing transition from the realm, which files nothing",
        "control.agent.transition-applied",
        { transition: { _tag: "continue", justification: "still reading" } },
        "continue · still reading"
      ],
      [
        "a continuing transition with nothing on it at all",
        "control.agent.transition-applied",
        { transition: {} },
        "continue"
      ],
      [
        "a printed cell",
        "control.agent.cell-printed",
        { cell: "d4", text: "42" },
        "print   42"
      ],
      [
        "a printed cell that printed nothing",
        "control.agent.cell-printed",
        { cell: "d4" },
        "print   "
      ],
      ["a settled cell", "control.agent.cell-settled", { outcome: { _tag: "settled" } }, "cell settled"],
      [
        "a failed cell",
        "control.agent.cell-settled",
        { outcome: { _tag: "failed", message: "boom" } },
        "cell FAILED boom"
      ],
      ["a cell with no outcome", "control.agent.cell-settled", {}, "cell ? "],
      ["an unrecognised kind", "control.run.pending", { runId: "run-1" }, "control.run.pending {\"runId\":\"run-1\"}"]
    ] as const
  )("renders %s", (_label, kind, payload, expected) => {
    expect(Forensics.eventLine(event(kind, payload, 1))).toBe(expected)
  })

  it("renders a payload JSON cannot serialize as its string form", () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string, which is the
    // one case the `?? String(value)` fallback exists for.
    expect(Forensics.eventLine(event("control.websocket.connected", undefined, 1)))
      .toBe("control.websocket.connected undefined")
  })

  it("clips an over-wide value and marks the elision", () => {
    const line = Forensics.eventLine(event("control.agent.cell-produced", { text: "x".repeat(200) }, 1))
    // 100 is the width: 99 kept characters plus the ellipsis.
    expect(line).toBe(`cell    ${"x".repeat(99)}…`)
  })

  it("keeps a value that is exactly the width intact", () => {
    const line = Forensics.eventLine(event("control.agent.cell-produced", { text: "x".repeat(100) }, 1))
    expect(line).toBe(`cell    ${"x".repeat(100)}`)
  })

  it("renders journaled text inert on the follow line and in the transcript", () => {
    // Model and cell text is untrusted: a cell can print a screen clear, a
    // cursor move, an OSC window title and a BEL, as Failure.test.ts pins for
    // the refusal path.
    const hostile = "ok\u001b[2J\u001b[1;1H FAKE: run completed\u001b]0;pwned\u0007\u009b31m\u200b"
    const events = [
      event("control.agent.turn-opened", { seat: `seat${hostile}` }, 0),
      event("control.agent.model-settled", { text: hostile }, 1),
      event("control.agent.cell-produced", { text: hostile }, 2),
      event("control.agent.cell-call-started", { flowName: `bash${hostile}`, input: { command: hostile } }, 3),
      event("control.agent.cell-call-settled", { outcome: "success", value: hostile }, 4),
      event("control.agent.cell-call-settled", { outcome: "failure", message: hostile }, 5)
    ]
    const unsafe = /[\p{Cc}\p{Cf}]/u
    for (const each of events) expect(Forensics.eventLine(each)).not.toMatch(unsafe)
    // A raw-text line keeps the words and loses the whole OSC sequence; a JSON
    // value already spells ESC as an inert backslash-u escape.
    expect(Forensics.eventLine(events[2]!)).toContain("ok FAKE: run completed")
    expect(Forensics.eventLine(events[2]!)).not.toContain("pwned")
    const transcript = Forensics.renderTranscript(events).replaceAll("\n", "")
    expect(transcript).not.toMatch(unsafe)
  })
})

describe("Forensics.renderDiagnosis boundaries", () => {
  it("reports a failure with no recorded cause as exactly that", () => {
    const d = Forensics.digest([event("control.run.failed", { runId: "run-1" }, 1)])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d))
      .toContain("Verdict   failed: no cause recorded in the journal")
  })

  it("reports a park with no recorded question as a pending gate", () => {
    const d = Forensics.digest([event("control.run.waiting-approval", { runId: "run-1" }, 1)])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d))
      .toContain("Verdict   waiting-approval: a permission gate is pending")
  })

  it("quotes the resolved output when the run both edited and completed", () => {
    const d = Forensics.digest([
      call("edit", { path: "a" }, 1),
      settledCall("edit", 2),
      event("control.agent.resolved", { text: "patched a\nand b" }, 3),
      event("control.run.completed", { runId: "run-1" }, 4)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1", flowId: "fix" }, d)
    expect(card).toContain("Verdict   completed: patched a")
    expect(card).toContain("Output    patched a")
  })

  it("falls back to the bare status when a completed run resolved with empty output", () => {
    const d = Forensics.digest([
      call("edit", { path: "a" }, 1),
      event("control.agent.resolved", { text: "" }, 2),
      event("control.run.completed", { runId: "run-1" }, 3)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card).toContain("Verdict   completed\n")
    expect(card).not.toContain("Output")
  })

  it("names an unlaunched run with no summary as unknown and zero-length", () => {
    const card = Forensics.renderDiagnosis(undefined, Forensics.digest([]))
    expect(card).toContain("Verdict   unlaunched")
    expect(card).toContain("Run       ? · 0s")
  })

  it("renders a run longer than a minute in minutes and padded seconds", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1" }, 0),
      event("control.run.completed", { runId: "run-1" }, 125_000)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).toContain("· 2m 05s")
  })

  it("keeps a run of exactly a minute in the minute form", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1" }, 0),
      event("control.run.completed", { runId: "run-1" }, 60_000)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).toContain("· 1m 00s")
  })

  it("keeps a run of just under a minute in the second form", () => {
    const d = Forensics.digest([
      event("control.run.running", { runId: "run-1" }, 0),
      event("control.run.completed", { runId: "run-1" }, 59_000)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).toContain("· 59s")
  })

  it("lists at most three refusals however many were recorded", () => {
    const d = Forensics.digest([
      refusedCall("a", 1),
      refusedCall("b", 2),
      refusedCall("c", 3),
      refusedCall("d", 4)
    ])
    const card = Forensics.renderDiagnosis({ runId: "run-1" }, d)
    expect(card.split("\n").filter((line) => line.includes("1× ")).length).toBe(3)
  })

  it("groups the thousands separator into the token line", () => {
    const d = Forensics.digest([
      event("control.agent.model-settled", { usage: { inputTokens: 1_234_567, outputTokens: 89 } }, 1)
    ])
    expect(Forensics.renderDiagnosis({ runId: "run-1" }, d)).toContain("Tokens    1,234,567 in / 89 out")
  })
})

describe("Forensics.renderTranscript boundaries", () => {
  it("renders each identified call lifecycle event once", () => {
    const started = event("control.agent.cell-call-started", { callId: "first", flowName: "read", input: {} }, 1)
    const settled = event(
      "control.agent.cell-call-settled",
      { callId: "first", flowName: "read", outcome: "success" },
      2
    )
    expect(Forensics.renderTranscript([started, started, settled, settled]))
      .toBe(Forensics.renderTranscript([started, settled]))
  })

  it("skips turn bookkeeping events and events outside the run and agent namespaces", () => {
    const text = Forensics.renderTranscript([
      event("control.agent.turn-opened", { seat: "s", at: 0 }, 0),
      event("control.agent.turn-closed", {}, 1_000),
      event("control.agent.steering-drained", {}, 2_000),
      event("control.websocket.connected", null, 3_000),
      event("control.approval.requested", { question: "May I?" }, 4_000)
    ])
    // Only the approval survives the filter: bookkeeping and transport events
    // are noise in a turn-by-turn read.
    expect(text).not.toContain("turn-closed")
    expect(text).not.toContain("steering-drained")
    expect(text).not.toContain("websocket")
    expect(text).toContain("[+00:04] approval.requested")
  })

  it("names an unattributed, never-launched history as unknown on both axes", () => {
    const orphan: ControlSchema.ControlEvent = {
      sequence: 1,
      kind: "control.agent.cell-produced",
      occurredAt: 0,
      payload: { text: "x" } as ControlSchema.ControlEvent["payload"]
    }
    expect(Forensics.renderTranscript([orphan])).toContain("? · ? · 0s · 0 turns")
  })

  it("headers a turn that opened without a seat", () => {
    expect(Forensics.renderTranscript([event("control.agent.turn-opened", {}, 0)]))
      .toContain("=== turn 1 ·  ===")
  })

  it("renders a delta whose admission stamp did not survive as an unstamped run", () => {
    // `digest` is total over malformed journal rows, so a delta with neither a
    // payload stamp nor an admission time still projects: the transcript keeps
    // the turn structure and reports an unknown run, status, and length.
    const unstamped = {
      sequence: 1,
      kind: "control.agent.turn-opened",
      payload: { seat: "openai:gpt-5.6-sol" }
    } as unknown as ControlSchema.ControlEvent
    const text = Forensics.renderTranscript([unstamped])
    expect(text).toContain("? · ? · 0s · 1 turns")
    expect(text).toContain("=== turn 1 · openai:gpt-5.6-sol ===")
  })

  it("offsets every line from the first event, not from zero", () => {
    const text = Forensics.renderTranscript([
      event("control.run.running", { runId: "run-1", at: 100_000 }, 100_000),
      event("control.run.completed", { runId: "run-1", at: 190_000 }, 190_000)
    ])
    expect(text).toContain("[+00:00] run.running")
    expect(text).toContain("[+01:30] run.completed")
  })
})

describe("Forensics.digest against the gateway's Diagnosis.digest", () => {
  /**
   * One journal exercising every fact both folds report, including the three
   * the two used to disagree on: a CRLF refusal message, a `control.run.*`
   * kind that names no status, and an event kind neither fold handles.
   */
  const journal: ReadonlyArray<ControlSchema.ControlEvent> = [
    event("control.run.running", { runId: "run-1" }, 1_000),
    turn(2_000),
    event("control.agent.model-settled", { text: "t", usage: { inputTokens: 12, outputTokens: 3 } }, 3_000),
    call("bash", { command: "ls" }, 4_000),
    refusedCall("Flow bash failed: refused\r\nstack", 5_000),
    call("edit", { path: "a.py" }, 6_000),
    settledCall("edit", 7_000),
    event("control.approval.requested", { question: "May I?", payload: { idempotencyKey: "k", scope: "run" } }, 8_000),
    event("control.run.lineage", { runId: "run-1" }, 9_000),
    event("control.agent.resolved", { text: "shipped\r\nrest" }, 10_000),
    event("control.run.completed", { runId: "run-1" }, 11_000),
    event("control.agent.cell-produced", { text: "trailing" }, 12_000)
  ]

  /** The facts both folds claim to report, read off either one. */
  const shared = (value: Diagnosis.Digest | Forensics.Digest) => ({
    status: value.status,
    cause: value.cause,
    seat: value.seat,
    turns: value.turns,
    calls: value.calls,
    callsFailed: value.callsFailed,
    editsAttempted: value.editsAttempted,
    editsSucceeded: value.editsSucceeded,
    refusals: value.refusals,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    finalOutput: value.finalOutput,
    parkedQuestion: value.parkedQuestion,
    startedAt: value.startedAt,
    endedAt: value.endedAt
  })

  it("reports the same facts the gateway reports for the same events", () => {
    expect(shared(Forensics.digest(journal))).toEqual(shared(Diagnosis.digest(journal)))
  })

  it("reads a status only off a kind that names one", () => {
    // `control.run.lineage` is journaled under the status prefix and names no
    // status. Read off the prefix alone it became the verdict of every
    // followed run, which is what a live `smthrs status` printed.
    expect(
      Forensics.digest([
        event("control.run.running", { runId: "run-1" }, 1_000),
        event("control.run.lineage", { runId: "run-1", parentRunId: "run-0" }, 2_000)
      ]).status
    ).toBe("running")
  })

  it("still reports the declined launch the wire vocabulary does not carry", () => {
    expect(Forensics.digest([event("control.run.pending", { runId: "run-1" }, 1_000)]).status).toBe("pending")
  })

  it("cuts a CRLF output at its first line, keeping no carriage return", () => {
    const card = Forensics.renderDiagnosis(
      { runId: "run-1" },
      Forensics.digest([
        event("control.agent.resolved", { text: "shipped\r\nrest" }, 1_000),
        event("control.run.completed", { runId: "run-1" }, 2_000)
      ])
    )
    expect(card.split("\n").find((line) => line.startsWith("Output"))).toBe(`${"Output".padEnd(10)}shipped`)
    expect(card.split("\n").find((line) => line.startsWith("Verdict"))).toBe(
      `${"Verdict".padEnd(10)}completed: shipped`
    )
  })

  it("clips a wide output on code points, never inside an astral character", () => {
    const card = Forensics.renderDiagnosis(
      { runId: "run-1" },
      Forensics.digest([
        event("control.agent.resolved", { text: "🙂".repeat(200) }, 1_000),
        event("control.run.completed", { runId: "run-1" }, 2_000)
      ])
    )
    // A `u`-flagged class matches a surrogate only where it stands alone, so
    // this is exactly "the card carries no half character".
    expect(/\p{Surrogate}/u.test(card)).toBe(false)
  })
})
