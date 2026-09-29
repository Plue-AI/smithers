import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { RegistrationFailure } from "./RegistrationCard"

/*
 * A registration's failure (docs/mvp/REGISTRATION.md): the import job's or
 * launch's own words never become the sentence. The stage the card reached
 * picks it, the raw text sits behind a collapsed Details, and Retry registers
 * the same link again.
 */

GlobalRegistrator.register()
const roots: Root[] = []

afterAll(async () => {
  for (const root of roots) flushSync(() => root.unmount())
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mount = (node: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    const root = createRoot(host)
    roots.push(root)
    root.render(node)
  })
  return host
}

const link = "https://github.com/smithersai/smithers"

describe("RegistrationFailure", () => {
  const cases = [
    {
      stage: "import",
      cloudRepo: null,
      raw: "The import couldn't start — GitHub answered 403",
      sentence: "Smithers could not import this repository. Not your fault."
    },
    {
      stage: "launch",
      cloudRepo: "smithersai/smithers",
      raw: "Current import failed. (HTTP 500)",
      sentence: "Smithers could not start setting up this repository. Not your fault."
    }
  ] as const
  for (const { stage, cloudRepo, raw, sentence } of cases) {
    test(`${stage}: the stage's sentence, the raw text only in Details, Retry registers the link again`, () => {
      const calls: Array<[string, string | undefined]> = []
      const host = mount(
        <RegistrationFailure payload={{ link, cloudRepo, error: raw }} onRunCommand={(name, args) => void calls.push([name, args])} />
      )
      const notice = host.querySelector<HTMLElement>(".registration-error")
      expect(notice?.getAttribute("role")).toBe("alert")
      expect(notice?.dataset.stage).toBe(stage)
      expect(notice?.dataset.fault).toBe("infra")
      expect(notice?.dataset.failure).toBe(`registration.${stage}`)
      expect(notice?.querySelector("p")?.textContent).toBe(sentence)
      expect(notice?.querySelector("p")?.textContent).not.toContain(raw)
      expect(notice?.querySelector("details")?.open).toBe(false)
      expect(notice?.querySelector("details pre")?.textContent).toBe(raw)
      const retry = notice?.querySelector<HTMLButtonElement>("button")
      expect(retry?.textContent).toBe("Retry")
      flushSync(() => retry?.click())
      expect(calls).toEqual([["repository.register", link]])
    })
  }

  test("no error draws nothing", () => {
    const host = mount(<RegistrationFailure payload={{ link, cloudRepo: null, error: null }} onRunCommand={() => {}} />)
    expect(host.innerHTML).toBe("")
  })
})
