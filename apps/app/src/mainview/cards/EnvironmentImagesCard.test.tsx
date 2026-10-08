import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { EnvironmentImagesCardBody } from "./EnvironmentImagesCard"

GlobalRegistrator.register()
const roots: Array<{ readonly unmount: () => void }> = []
afterAll(async () => {
  for (const root of roots) flushSync(() => root.unmount())
  await new Promise(resolve => setTimeout(resolve, 0))
  GlobalRegistrator.unregister()
})

describe("the environment images card", () => {
  const imagesCard = (
    images: Extract<Card, { kind: "environment-images" }>["payload"]["images"]
  ): Extract<Card, { kind: "environment-images" }> => ({
    id: "environment-images-will/smithers",
    kind: "environment-images",
    title: "Environment images · will/smithers",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: { repo: "will/smithers", images }
  })

  const renderImages = (card: Extract<Card, { kind: "environment-images" }>) => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    flushSync(() => {
      root.render(<EnvironmentImagesCardBody card={card} />)
    })
    return host
  }

  test("a row names its kind, the closure short, the image tag and its status", () => {
    const host = renderImages(
      imagesCard([
        {
          id: "4",
          kind: "desktop",
          source: ".smithers/environment.nix",
          sourceRevision: "b3f21c9d4e5a6b7c",
          closureHash: "9f2b1c0d4e5a6b7c8d9e0f1a",
          image: "registry.smithers-cloud.test/environments/smithersai/smithers:nixos-2405-9f2b1c0d",
          status: "ready",
          platformBase: false,
          coldPull: false
        }
      ])
    )
    const text = host.textContent ?? ""
    expect(text).toContain("desktop")
    expect(text).toContain("9f2b1c0d")
    expect(text).toContain("nixos-2405-9f2b1c0d")
    /* The shared StatusPill title-cases plue's own word. */
    expect(text).toContain("Ready")
    // The whole registry path is never printed — the tag is what identifies the build.
    expect(text).not.toContain("registry.smithers-cloud.test")
    expect(text).not.toContain("cold pull")
    host.remove()
  })

  test("an image with nothing baked warns that its first boot is a cold pull, and the platform base says so", () => {
    const host = renderImages(
      imagesCard([
        {
          id: "1",
          kind: "vm",
          source: "platform",
          sourceRevision: null,
          closureHash: "1122334455667788",
          image: "registry.smithers-cloud.test/environments/base:nixos-2405",
          status: "building",
          platformBase: true,
          coldPull: true
        }
      ])
    )
    const text = host.textContent ?? ""
    expect(text).toContain("platform base")
    expect(text).toContain("first boot is a cold pull")
    host.remove()
  })

  test("a repository that has built nothing says so", () => {
    const host = renderImages(imagesCard([]))
    expect(host.textContent).toContain("will/smithers has built no environment images.")
    host.remove()
  })
})

