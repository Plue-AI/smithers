import { testRender } from "@opentui/react/test-utils"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import { ModelError } from "@smthrs/model/ModelError"
import { afterEach, describe, expect, it } from "bun:test"
import { FailureCard } from "../src/panel-view.tsx"
import * as Tabs from "../src/tabs.ts"
import * as Transcript from "../src/transcript.ts"
import type * as Workspace from "../src/workspace.ts"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

const tab = {
  id: "review",
  depth: 0,
  title: "Review",
  prompt: "Review files",
  seat: "openai:gpt-6-sol",
  file: "/tmp/worker.jsonl",
  status: "failed",
  startedAt: 1,
  message: "secret raw provider response",
  detail: "secret stack",
  failure: {
    headline: "OpenAI usage limit reached",
    fault: "wait",
    line: "Resets Sep 30, 02:00 PM.",
    actions: ["resume", "switch-model", "wait", "details"]
  }
} satisfies Workspace.Tab

describe("worker failure card", () => {
  it("retains Wait for reset through quota copy, worker actions, and the rendered card", async () => {
    for (const timing of [{ resetAtEpochMillis: Date.now() + 60_000 }, { retryAfterMillis: 60_000 }]) {
      const failure = FailureCopy.describe(
        new ModelError({ code: "quota_exceeded", message: "wait", ...timing }),
        tab.seat
      )
      const failed = { ...tab, failure }
      expect(Tabs.actions(failed).map((action) => action.keys[0])).toContain("alt+w")
      expect(Tabs.actions(failed).find((action) => action.id === "wait")?.label).toBe("Wait for reset")
      setup = await testRender(<FailureCard tab={failed} transcript={Transcript.empty} details={false} />, {
        width: 100,
        height: 8
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain("[w] Wait for reset")
      setup.renderer.destroy()
      setup = undefined
    }
    const terminal = {
      ...tab,
      failure: FailureCopy.describe(new ModelError({ code: "quota_exceeded", message: "empty" }), tab.seat)
    }
    expect(Tabs.actions(terminal).map((action) => action.keys[0])).toEqual(["alt+m", "alt+r"])
  })

  it("shows a body-load refusal in expanded details without a private stack", async () => {
    setup = await testRender(
      <FailureCard
        tab={{
          ...tab,
          code: "unreadable",
          message: "Body unavailable",
          detail: undefined,
          failure: { headline: "Body unavailable", fault: "user", line: "", actions: ["resume", "details"] }
        }}
        transcript={Transcript.empty}
        details
      />,
      { width: 100, height: 8 }
    )
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Body unavailable")
    expect(setup.captureCharFrame()).toContain("Resume here")
    expect(setup.captureCharFrame()).not.toContain("private stack")
  })

  it("renders the headline, progress, file impact and keys without raw provider text", async () => {
    setup = await testRender(<FailureCard tab={tab} transcript={Transcript.empty} details={false} />, {
      width: 100,
      height: 8
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("OpenAI usage limit reached")
    expect(frame).toContain("No files changed")
    expect(frame).toContain("[r] Resume here")
    expect(frame).not.toContain("secret raw")
    expect(frame).not.toContain("secret stack")
  })

  it("says failed and its cause, never whose fault it is", async () => {
    for (const fault of ["policy", "factory", "user", "wait", "infra", "dependency", "bug"] as const) {
      setup = await testRender(
        <FailureCard
          tab={{ ...tab, failure: { ...tab.failure, fault } }}
          transcript={Transcript.empty}
          details={false}
        />,
        { width: 100, height: 8 }
      )
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame.split("\n")[0]?.trim()).toBe("failed: OpenAI usage limit reached")
      expect(frame).not.toContain("fault")
      expect(frame).not.toContain("cap reached")
      expect(frame).not.toContain("needs you")
      expect(frame).not.toMatch(new RegExp(`· ${fault}\\b`))
      setup.renderer.destroy()
      setup = undefined
    }
  })

  for (const code of ["quota_exceeded", "out_of_credit"] as const) {
    for (const width of [80, 110]) {
      it(`offers Switch model first for ${code} at ${width} columns`, async () => {
        const failure = FailureCopy.describe(new ModelError({ code, message: "private provider reply" }), tab.seat)
        setup = await testRender(
          <FailureCard tab={{ ...tab, failure }} transcript={Transcript.empty} details={false} />,
          { width, height: 8 }
        )
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        expect(frame).toContain(failure.headline)
        expect(frame).toMatch(/\[m\] Switch model +\[r\] Resume here/)
        expect(frame).not.toContain("Wait for reset")
        expect(frame).not.toContain("waiting")
        expect(frame).not.toContain("private provider reply")
      })
    }
  }

  it("renders only the actions offered by the failure", async () => {
    setup = await testRender(
      <FailureCard
        tab={{ ...tab, failure: { ...tab.failure, actions: ["resume", "details"] } }}
        transcript={Transcript.empty}
        details={false}
      />,
      { width: 80, height: 8 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("[r] Resume here")
    expect(frame).toContain("[ctrl+o] Details")
    expect(frame).not.toContain("Switch model")
    expect(frame).not.toContain("Wait for reset")
  })

  it("shows raw diagnostics only when details are open", async () => {
    setup = await testRender(<FailureCard tab={tab} transcript={Transcript.empty} details />, { width: 100, height: 8 })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("secret stack")
  })

  it("shows a budget headline once while retaining the raw cause in details", async () => {
    setup = await testRender(
      <FailureCard
        tab={{
          ...tab,
          message: "Token budget reached",
          detail: "The run has spent 600 of its 1000 approved tokens.",
          failure: {
            headline: "Token budget reached",
            fault: "user",
            line: "600 of 1000 tokens used.",
            actions: ["resume", "details"]
          }
        }}
        transcript={Transcript.empty}
        details
      />,
      { width: 100, height: 10 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame.match(/Token budget reached/g)).toHaveLength(1)
    expect(frame).toContain("600 of its 1000 approved tokens")
  })

  it("does not add an empty details row when the headline is all that survived", async () => {
    const restored = {
      ...tab,
      message: "Token budget reached",
      detail: undefined,
      failure: {
        headline: "Token budget reached",
        fault: "user" as const,
        line: "The run spent its budget.",
        actions: ["resume", "details"] as const
      }
    }
    setup = await testRender(
      <box>
        <FailureCard tab={restored} transcript={Transcript.empty} details />
        <text>after card</text>
      </box>,
      { width: 100, height: 8 }
    )
    await setup.renderOnce()
    const withDetails = setup.captureCharFrame()
    expect(withDetails.match(/Token budget reached/g)).toHaveLength(1)
    setup.renderer.destroy()
    setup = await testRender(
      <box>
        <FailureCard tab={restored} transcript={Transcript.empty} details={false} />
        <text>after card</text>
      </box>,
      { width: 100, height: 8 }
    )
    await setup.renderOnce()
    expect(withDetails).toBe(setup.captureCharFrame())
  })

  it("counts completed steps and actual patch receipts", async () => {
    const transcript: Transcript.Transcript = {
      ...Transcript.empty,
      items: [{
        kind: "cell",
        id: "1",
        index: 1,
        prose: "Edited",
        source: "edit()",
        status: "done",
        printed: "done",
        startedAt: 1,
        endedAt: 2,
        calls: [{
          flow: "edit",
          subject: "a.ts",
          status: "ok",
          startedAt: 1,
          patches: [{ path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }]
        }]
      }]
    }
    setup = await testRender(<FailureCard tab={tab} transcript={transcript} details={false} />, {
      width: 100,
      height: 8
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("1 of ~40 steps done")
    expect(frame).toContain("Files changed")
  })

  it("says files changed for a binary-only change undo cannot reverse, and not once it is undone", async () => {
    const binary = (undone: boolean): Transcript.Transcript => ({
      ...Transcript.empty,
      items: [{
        kind: "cell",
        id: "1",
        index: 1,
        prose: "Wrote",
        source: "write()",
        status: "done",
        printed: "done",
        startedAt: 1,
        endedAt: 2,
        calls: [{
          flow: "write",
          subject: "logo.png",
          status: "ok",
          startedAt: 1,
          patches: [{ path: "logo.png", patch: "Binary or large file: logo.png", ...(undone ? { undone: true } : {}) }]
        }]
      }]
    })
    for (const [undone, line] of [[false, "Files changed."], [true, "No files changed."]] as const) {
      setup = await testRender(<FailureCard tab={tab} transcript={binary(undone)} details={false} />, {
        width: 100,
        height: 8
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(line)
      setup.renderer.destroy()
      setup = undefined
    }
  })

  it("renders a timeout with a human fault label", async () => {
    setup = await testRender(
      <FailureCard
        tab={{
          ...tab,
          failure: FailureCopy.describe(
            new ModelError({ code: "call_timeout", message: "request timed out" }),
            tab.seat
          )
        }}
        transcript={Transcript.empty}
        details={false}
      />,
      { width: 100, height: 8 }
    )
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("failed: Model call timed out")
    expect(frame).not.toContain("·  wait")
  })
})
