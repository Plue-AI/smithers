import { describe, expect, test } from "vitest"
import { RuntimeCapabilitySchema } from "../src/AppBootstrap.ts"
import { cloudCapabilities, localCapabilities } from "../src/HostCapabilities.ts"

const booleans = [false, true] as const

test("recommendations and command selection require the same explicitly configured provider on either host", () => {
  const recommendationSettings: readonly (boolean | undefined)[] = [undefined, false, true]
  for (const recommend of recommendationSettings) {
    for (const otherFeatures of booleans) {
      const hosts = [
        cloudCapabilities({
          identity: otherFeatures,
          cloud: otherFeatures,
          agent: otherFeatures,
          checkout: otherFeatures,
          terminal: otherFeatures,
          ...(recommend === undefined ? {} : { recommend })
        }),
        localCapabilities({
          identity: otherFeatures,
          cloud: otherFeatures,
          agent: otherFeatures,
          nativeShell: otherFeatures,
          ...(recommend === undefined ? {} : { recommend })
        })
      ]
      for (const capabilities of hosts) {
        expect(capabilities.includes("recommend")).toBe(recommend === true)
        expect(capabilities.includes("commands.select")).toBe(recommend === true)
        expect(capabilities.filter((capability) => capability === "commands.select")).toHaveLength(
          recommend === true ? 1 : 0
        )
        for (const capability of capabilities) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
      }
    }
  }
})

test("balance support is explicit and independent of identity and checkout", () => {
  for (const balance of booleans) {
    for (const checkout of booleans) {
      const cloud = cloudCapabilities({ identity: true, cloud: true, agent: true, terminal: false, balance, checkout })
      expect(cloud.includes("billing.balance")).toBe(balance)
      expect(cloud.includes("billing.checkout")).toBe(checkout)
      expect(localCapabilities({ identity: true, cloud: true, agent: true, balance }).includes("billing.balance")).toBe(
        balance
      )
    }
  }
  expect(localCapabilities({ identity: true, cloud: true, agent: true })).not.toContain("billing.balance")
})

test("browser.read requires an explicitly configured pinned transport on either host", () => {
  const cloud = { identity: true, cloud: true, agent: true, checkout: false, terminal: false }
  const local = { identity: true, cloud: true, agent: true }
  expect(cloudCapabilities(cloud)).not.toContain("browser.read")
  expect(localCapabilities(local)).not.toContain("browser.read")
  expect(cloudCapabilities({ ...cloud, browser: true })).toContain("browser.read")
  expect(localCapabilities({ ...local, browser: true })).toContain("browser.read")
})

describe("cloudCapabilities (the Worker, host cloud)", () => {
  test("a fully configured Worker emits the four capabilities the Worker emits today, in its order", () => {
    expect(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "cloud", "billing.checkout"])
  })

  test("an unconfigured Worker emits nothing", () => {
    expect(cloudCapabilities({ identity: false, cloud: false, agent: false, checkout: false, terminal: false }))
      .toEqual([])
  })

  test("each flag gates only its own capability", () => {
    expect(cloudCapabilities({ identity: true, cloud: false, agent: true, checkout: true, terminal: false }))
      .toEqual(["agent", "identity", "billing.checkout"])
    expect(cloudCapabilities({ identity: false, cloud: true, agent: false, checkout: false, terminal: false }))
      .toEqual(["cloud"])
  })

  test("cloud.terminal appears last and only when the relay is on", () => {
    expect(cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }))
      .toEqual(["agent", "identity", "cloud", "billing.checkout", "cloud.terminal"])
    expect(cloudCapabilities({ identity: false, cloud: false, agent: false, checkout: false, terminal: true }))
      .toEqual(["cloud.terminal"])
  })

  test("the Worker never claims cloud.pat or native.shell and every entry is a known capability", () => {
    for (const identity of booleans) {
      for (const cloud of booleans) {
        for (const agent of booleans) {
          for (const checkout of booleans) {
            for (const terminal of booleans) {
              const emitted = cloudCapabilities({ identity, cloud, agent, checkout, terminal })
              expect(emitted).not.toContain("cloud.pat")
              expect(emitted).not.toContain("native.shell")
              expect(emitted.includes("cloud.terminal")).toBe(terminal)
              expect(new Set(emitted).size).toBe(emitted.length)
              for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
            }
          }
        }
      }
    }
  })
})

describe("localCapabilities (the Bun server, host local)", () => {
  test("a hybrid launch emits what the Bun server emits today: both cloud doors and no local backend", () => {
    expect(localCapabilities({ agent: true, identity: true, cloud: true })).toEqual([
      "agent",
      "model.turn",
      "identity",
      "cloud",
      "cloud.terminal",
      "cloud.pat"
    ])
  })

  test("an offline launch can serve a configured model without a default agent", () => {
    expect(localCapabilities({ agent: false, identity: false, cloud: false })).toEqual(["model.turn"])
  })

  test("the chat stub is an agent without identity or Smithers Cloud", () => {
    expect(localCapabilities({ agent: true, identity: false, cloud: false })).toEqual(["agent", "model.turn"])
  })

  test("no launch claims a local backend door: the local backend retired (apps/app/docs/LOCAL-BACKEND-RETIREMENT.md)", () => {
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const cloud of booleans) {
          for (const capability of localCapabilities({ agent, identity, cloud })) {
            expect(capability.startsWith("local.")).toBe(false)
          }
        }
      }
    }
  })

  test("native.shell is emitted last, only when the desktop shell started the host", () => {
    expect(localCapabilities({ agent: true, identity: false, cloud: false, nativeShell: true })).toEqual([
      "agent",
      "model.turn",
      "native.shell"
    ])
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const cloud of booleans) {
          expect(localCapabilities({ agent, identity, cloud })).not.toContain("native.shell")
          expect(localCapabilities({ agent, identity, cloud, nativeShell: false })).not.toContain("native.shell")
          expect(localCapabilities({ agent, identity, cloud, nativeShell: true }).at(-1)).toBe("native.shell")
        }
      }
    }
  })

  test("the cloud doors ride the Smithers Cloud upstream: offline answers 501 on /api/cloud-auth and /api/cloud-ws", () => {
    for (const agent of booleans) {
      for (const identity of booleans) {
        for (const cloud of booleans) {
          const emitted = localCapabilities({ agent, identity, cloud })
          expect(emitted.includes("cloud")).toBe(cloud)
          expect(emitted.includes("cloud.terminal")).toBe(cloud)
          expect(emitted.includes("cloud.pat")).toBe(cloud)
          expect(new Set(emitted).size).toBe(emitted.length)
          for (const capability of emitted) expect(RuntimeCapabilitySchema.safeParse(capability).success).toBe(true)
        }
      }
    }
  })
})

test("overview, plans and portal are independent from checkout", () => {
  for (const overview of booleans) {
    for (const plans of booleans) {
      for (const portal of booleans) {
        for (const checkout of booleans) {
          const cloud = cloudCapabilities({
            identity: true,
            cloud: true,
            agent: true,
            terminal: false,
            overview,
            plans,
            portal,
            checkout
          })
          const local = localCapabilities({ identity: true, cloud: true, agent: true, overview, plans, portal })
          for (const emitted of [cloud, local]) {
            expect(emitted.includes("billing.overview")).toBe(overview)
            expect(emitted.includes("billing.plans")).toBe(plans)
            expect(emitted.includes("billing.portal")).toBe(portal)
          }
          expect(cloud.includes("billing.checkout")).toBe(checkout)
        }
      }
    }
  }
})
