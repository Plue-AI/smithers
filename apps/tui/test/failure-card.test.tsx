import { testRender } from "@opentui/react/test-utils"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import { ModelError } from "@smthrs/model/ModelError"
import { afterEach, describe, expect, it } from "bun:test"
import { FailureCard } from "../src/panel-view.tsx"
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
    headline: "ChatGPT usage limit reached",
    fault: "wait",
    line: "Resets Sep 30, 02:00 PM.",
    actions: ["resume", "switch-model", "wait", "details"]
  }
} satisfies Workspace.Tab

describe("worker failure card", () => {
  it("renders the headline, progress, file impact and keys without raw provider text", async () => {
    setup = await testRender(<FailureCard tab={tab} transcript={Transcript.empty} details={false} />, {
      width: 100,
      height: 8
    })
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("ChatGPT usage limit reached")
    expect(frame).toContain("No files changed")
    expect(frame).toContain("[r] Resume here")
    expect(frame).not.toContain("secret raw")
    expect(frame).not.toContain("secret stack")
  })

  it("names whose problem it is in product words, never the internal class", async () => {
    for (
      const [fault, label] of [
        ["policy", "cap reached"],
        ["factory", "not your fault"],
        ["user", "needs you"],
        ["wait", "not your fault · waiting"]
      ] as const
    ) {
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
      expect(frame).toContain(label)
      expect(frame).not.toMatch(new RegExp(`· ${fault}\\b(?!ing)`))
      setup.renderer.destroy()
      setup = undefined
    }
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
    expect(frame).toContain("Model call timed out")
    expect(frame).not.toContain("·  wait")
  })
})
