import { createRoot } from "./cards/views/testDom"
import { act } from "react"
import { expect, test } from "bun:test"
import { ToastStack } from "./ToastStackView"
import { railNotices, toastActions } from "./ShellRail"
import { firstNotificationAsk } from "./state/controller/failures"
import { createAppStore } from "./state/AppStore"
import { createAppController } from "./state/AppController"
import { memoryStorage, unavailableAgent } from "./state/TestFixtures"

for (const mode of ["allowed", "denied", "insecure", "unsupported", "dark"] as const) {
  test(`rendered Allow uses synchronous person dispatcher: ${mode}`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "Notification")
    const previousSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext")
    let requests = 0
    let resolve!: (value: NotificationPermission) => void
    class RecordedNotification {
      static permission = mode === "denied" ? "denied" : "default"
      static requestPermission() { requests++; return new Promise<NotificationPermission>(done => { resolve = done }) }
    }
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: mode !== "insecure" })
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: mode === "unsupported" ? undefined : RecordedNotification })
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableAgent, {})
    const host = document.createElement("div"); document.body.append(host)
    const root = createRoot(host)
    try {
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "ben", provider: "github", admin: false, scopesPlain: null }).isPersisted.promise
      for (const key of ["q1", "q2"]) await store.dispatch({ type: "toast.shown", actor: "system", key, title: "Needs you",
        ...(mode === "dark" ? {} : { audience: { member: "ben", entryId: key, kind: "needs_you" as const, actorLabel: "Coding agent for Ben", target: { flow: "todo" as const, n: 3 } } }) }).isPersisted.promise
      expect(controller.commands.toolSpecs().some(spec => spec.name === "notifications.allow")).toBe(false)
      await controller.commands.runAsAgent("notifications.allow")
      await controller.commands.run("notifications.allow", undefined, "automatic")
      await controller.commands.preload?.("notifications.allow")
      await controller.commands.run("notifications.allow")
      expect(requests).toBe(0)
      const ask = firstNotificationAsk([...store.collections.toasts.values()], "ben")
      expect(ask?.key).toBe(mode === "allowed" ? "q1" : undefined)
      if (mode === "allowed") {
        // The first question can leave before the person answers the permission ask.
        for (const id of ["toast-q1", "toast-q2"]) await store.dispatch({ type: "toast.dismissed", actor: "user", id }).isPersisted.promise
      }
      await store.dispatch({ type: "toast.shown", actor: "system", key: "unrelated", title: "Working" }).isPersisted.promise
      const rows = [...store.collections.toasts.values()]
      // Production ShellRail callback and supplied T-UI-08 View, with its real button.
      act(() => root.render(<ToastStack toasts={railNotices(rows, [], "ben")} more={0} onAction={toastActions(controller, rows)} onView={patch => { if (patch.toast_hidden) controller.runCommand("toast.dismiss", patch.toast_hidden) }} />))
      expect(host.querySelectorAll('[data-flow="notifications.allow"]').length).toBe(mode === "allowed" ? 1 : 0)
      if (mode === "allowed") {
        act(() => (host.querySelector('[data-flow="notifications.allow"]') as HTMLButtonElement).click())
        // The permission promise remains unresolved: the API already ran in click.
        expect(requests).toBe(1)
        act(() => (host.querySelector('[data-flow="notifications.allow"]') as HTMLButtonElement).click())
        expect(requests).toBe(1)
        resolve("denied")
      } else {
        await controller.commands.submit({ name: "notifications.allow", payload: {}, actor: "user" })
        expect(requests).toBe(0)
      }
      expect(store.collections.toasts.get("toast-unrelated")?.title).toBe("Working")
    } finally {
      act(() => root.unmount()); await controller.dispose(); await store.dispose?.()
      if (previous) Object.defineProperty(globalThis, "Notification", previous); else Reflect.deleteProperty(globalThis, "Notification")
      if (previousSecure) Object.defineProperty(window, "isSecureContext", previousSecure); else Reflect.deleteProperty(window, "isSecureContext")
    }
  })
}
