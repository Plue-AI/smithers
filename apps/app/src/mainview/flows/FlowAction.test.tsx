import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { bindFlowPreloading, flowAction } from "./FlowAction"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

test("hover, keyboard focus and touch warm the exact click arguments without clicking", () => {
  const warmed: string[][] = [], clicked: string[][] = []
  const binding = flowAction((name, args) => { clicked.push([name, args!]) }, "file", '"a file.md" will/demo')
  const button = document.createElement("button")
  button.dataset.flow = binding["data-flow"]
  button.dataset.flowArgs = binding["data-flow-args"]
  const icon = document.createElement("span"); button.append(icon)
  button.onclick = binding.onClick; document.body.append(button)
  const stop = bindFlowPreloading(document, async (name, args) => { warmed.push([name, args!]) })
  try {
    for (const event of ["pointerover", "focusin", "pointerdown"]) icon.dispatchEvent(new Event(event, { bubbles: true }))
    expect(warmed).toEqual(Array(3).fill(["file", '"a file.md" will/demo']))
    expect(clicked).toEqual([])
    button.click()
    expect(clicked).toEqual([["file", '"a file.md" will/demo']])
    button.disabled = true
    icon.dispatchEvent(new Event("pointerover", { bubbles: true }))
    expect(warmed).toHaveLength(3)
    stop()
    button.disabled = false
    icon.dispatchEvent(new Event("focusin", { bubbles: true }))
    expect(warmed).toHaveLength(3)
  } finally { stop(); button.remove() }
})
