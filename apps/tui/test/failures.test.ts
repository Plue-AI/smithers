import { describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AgentError } from "../src/agents.ts"
import * as Cli from "../src/cli.ts"
import { Refusal } from "../src/contributions.ts"
import * as Failures from "../src/failures.ts"
import { FlowDiscoveryFailed, FlowError } from "../src/flows.ts"
import * as Log from "../src/log.ts"
import { MonitorError } from "../src/monitors.ts"
import * as Session from "../src/session.ts"
import * as Command from "../src/tab-command.ts"
import { TabError } from "../src/tab-error.ts"
import { AgentDepthExceeded } from "../src/workspace.ts"

// Every raw message below carries this, so one check proves none reached the sentence.
const RAW = "ECONNRESET at socket.ts:42"
const logged = (): string => existsSync(Log.path()) ? readFileSync(Log.path(), "utf8") : ""

const sentence = (error: unknown) => Failures.present("worker", error)

describe("tagged failures read as one plain sentence", () => {
  it("words every agent refusal code by its subject, never its message", () => {
    const cases: ReadonlyArray<readonly [AgentError, string, string]> = [
      [new AgentError("unknown_agent", RAW, "review"), "No agent named review; /agent lists them.", "user"],
      [new AgentError("unknown_agent", RAW), "No such agent; /agent lists them.", "user"],
      [new AgentError("seat_as_agent", RAW, "luna"), "luna is a model; choose it with /model.", "user"],
      [new AgentError("not_an_agent", RAW, "echo"), "echo is a flow; run it with /flow.", "user"],
      [new AgentError("not_invocable", RAW, "deploy"), "deploy starts only from /agent.", "user"],
      [new AgentError("unreadable", RAW, "review"), "Agent review could not be read; press r.", "infra"],
      [new AgentError("unreadable", RAW), "The agent file could not be read; press r.", "infra"],
      [new AgentError("unknown_seat", RAW, "gpt-9"), "Unknown model gpt-9.", "user"],
      [new AgentError("unknown_effort", RAW, "extreme"), "Unknown effort extreme.", "user"],
      [new AgentError("unavailable", RAW), "Agents are not available in this session.", "infra"]
    ]
    for (const [error, words, fault] of cases) {
      expect(sentence(error)).toMatchObject({ tag: "AgentError", sentence: words, fault })
      expect(error.message).toBe(RAW)
    }
  })

  it("words every flow code and keeps a person's own stop quiet", () => {
    const cases: ReadonlyArray<readonly [FlowError, string, string]> = [
      [new FlowError("unknown_flow", RAW, { subject: "nope" }), "No flow named nope; /flows lists them.", "user"],
      [new FlowError("refused", RAW, { subject: "ship" }), "ship cannot start here.", "user"],
      [new FlowError("person_only", RAW, { subject: "deploy" }), "deploy starts only from /flow.", "user"],
      [new FlowError("denied", RAW, { subject: "ship" }), "ship was not approved.", "user"],
      [new FlowError("stopped", "Stopped"), "Stopped.", "user"],
      [new FlowError("invalid_input", RAW, { subject: "echo" }), "echo did not accept that input.", "user"],
      [new FlowError("launch", RAW), "The flow could not launch; press r.", "infra"],
      [new FlowError("control", RAW, { cause: new Error(RAW) }), "Lost contact with the flow runner; press r.", "infra"]
    ]
    for (const [error, words, fault] of cases) {
      expect(sentence(error)).toMatchObject({ tag: "FlowError", sentence: words, fault })
    }
    expect(sentence(new FlowDiscoveryFailed(new Error(RAW)))).toMatchObject({
      sentence: "Flows could not be listed; the last list stays.",
      fault: "infra"
    })
  })

  it("words every tab refusal a key or /retry can hit", () => {
    const cases: ReadonlyArray<readonly [TabError, string]> = [
      [new TabError("unknown_tab", RAW, "w1"), "No tab w1."],
      [new TabError("not_retryable", RAW, "w1"), "Only a failed, stopped or parked tab can be retried."],
      [new TabError("not_capped", RAW, "w1"), "Only a worker stopped at its cap takes a new one."],
      [new TabError("not_failed", RAW, "w1"), "Only a failed tab can wait."],
      [new TabError("closed", RAW), "This session is closing."]
    ]
    for (const [error, words] of cases) expect(sentence(error)).toMatchObject({ sentence: words, fault: "user" })
    expect(sentence(new TabError("flows_unavailable", RAW))).toMatchObject({ fault: "infra" })
  })

  it("words monitor, session, plugin, depth and approval failures", () => {
    expect(sentence(new MonitorError({ _tag: "JevFailed", code: "timeout", message: RAW })).sentence).toBe(
      "Jev timed out."
    )
    expect(sentence({ _tag: "LunaFailed", message: RAW }).sentence).toBe("Luna could not summarize the change.")
    expect(sentence({ _tag: "SourceFailed", message: RAW }).sentence).toBe("The watched source could not be read.")
    expect(sentence({ _tag: "Refused", message: RAW }).sentence).toBe("The watch command was not approved.")
    expect(sentence(new Session.Corrupt("/s/a.jsonl", 7)).sentence).toBe("That conversation is damaged at line 7.")
    expect(sentence({ _tag: "SessionWriteFailed", file: "/s", message: RAW }).sentence).toBe(
      "The conversation is not being saved; check the disk."
    )
    expect(sentence(new Refusal("limit", RAW)).sentence).toBe("A plugin reached its limit.")
    expect(sentence(new Refusal("collision", RAW)).sentence).toBe("A plugin key clashes with another.")
    expect(sentence(new Refusal("invalid", RAW)).sentence).toBe("A plugin sent something invalid.")
    expect(sentence(new AgentDepthExceeded()).sentence).toBe("Workers can delegate three levels deep.")
    expect(Failures.present("approval", Failures.grantRefusal("journal_failed"))).toMatchObject({
      sentence: "Your answer was not saved; press y, n or a again.",
      fault: "infra"
    })
    expect(Failures.present("approval", Failures.grantRefusal("request_not_found")).fault).toBe("user")
  })
})

describe("unknown failures", () => {
  it("get the act's sentence, a details pointer, and a log record with the raw text", () => {
    const error = new Error(RAW)
    const line = Failures.line("fork", error)
    expect(line).toBe("This conversation could not be forked. Details: /conversation")
    expect(Failures.present("fork", "a thrown string").tag).toBeNull()
    expect(logged()).toContain(RAW)
  })

  it("a failure the person caused names no details and writes no log", () => {
    const before = logged()
    expect(Failures.line("flow", new FlowError("unknown_flow", "unique-unlogged", { subject: "x" }))).toBe(
      "No flow named x; /flows lists them."
    )
    expect(logged()).toBe(before)
  })

  it("a headless command names the log file", () => {
    expect(Failures.line("startup", new Error(RAW), `Details: ${Log.path()}`)).toBe(
      `The terminal could not start. Details: ${Log.path()}`
    )
    expect(Failures.detailsIn(new Error("harness-raw"))).toBe(`Details: ${Log.path()}`)
    expect(logged()).toContain("harness-raw")
  })
})

describe("surfaces", () => {
  it("/retry and /stop report a sentence for a thrown refusal or an unknown error", () => {
    const reports: string[] = []
    const refusing = {
      has: () => true,
      retry: () => {
        throw new TabError("not_retryable", RAW, "w")
      },
      cancel: () => {
        throw new Error(RAW)
      }
    }
    const options = { flows: refusing, workers: refusing, pick: () => {}, report: (m: string) => reports.push(m) }
    Command.run("retry", "w", options)
    Command.run("stop", "w", options)
    expect(reports).toEqual([
      "Only a failed, stopped or parked tab can be retried.",
      "The stop was not sent; press x again. Details: /conversation"
    ])
  })

  it("a damaged conversation is named by line and moved aside", () => {
    const writer = Session.create("/work/failures")
    writer.append({ type: "user", at: 1, text: "one" })
    appendFileSync(writer.file, "{oops\n")
    writer.append({ type: "user", at: 2, text: "two" })
    const error = (() => {
      try {
        Session.load(writer.file)
      } catch (error) {
        return error
      }
    })()
    const name = writer.file.split("/").at(-1)
    expect(Session.quarantine(writer.file, error)).toBe(
      `That conversation is damaged at line 3. Moved to ${name}.damaged.`
    )
    expect(Session.quarantine(join(writer.file, "missing"), new Error(RAW))).toBe(
      "That conversation could not be opened. Details: /conversation"
    )
  })

  it("the command line words argument refusals, not Node's parser text", () => {
    expect(Cli.parse(["--nope"], "/")).toEqual({ error: "Unknown option --nope" })
    expect(Cli.parse(["-z"], "/")).toEqual({ error: "Unknown option -z" })
    expect(Cli.parse(["--box=a/b/c", "--zz=1"], "/")).toEqual({ error: "Unknown option --zz" })
    expect(Cli.parse(["--model"], "/")).toEqual({ error: "--model needs a value" })
    expect(Cli.parse(["--continue=1"], "/")).toEqual({ error: "--continue takes no value" })
  })
})
