import { expect } from "@playwright/test"
import { showcase } from "../showcase"
import { identityRoute } from "../../playwright/identity"

export default showcase({
  id: "signup",
  order: 10,
  title: "Sign up",
  summary: "GitHub sign-in, account, a short poll, then the workspace.",
  flows: ["auth.sign-in", "signup.account", "signup.answer", "signup.next", "signup.repo", "signup.finish"],
  run: async ({ page, app, backend }) => {
    let signedIn = false
    await backend.signedOut()
    await backend.route(url => url.pathname === "/api/user", route => identityRoute(signedIn ? "adapark" : null)(route))
    await backend.json("/api/billing/balance", { state: "ok", allowedToStartWork: true, balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 } })
    // The GitHub round trip: the redirect comes straight back signed in.
    await backend.route(url => url.pathname.startsWith("/api/auth/github"), route => {
      signedIn = true
      return route.fulfill({ status: 302, headers: { location: "/" } })
    })

    await app.open("/")
    const signup = page.getByTestId("signup")
    await expect(signup.locator("h1")).toHaveText(/Automate\s+maintaining\s+your\s+codebase/)
    await expect(page.getByTestId("signup-github")).toBeVisible()
    await app.beat(1600)
    await app.click(page.getByTestId("signup-github"))

    await expect(page.getByTestId("signup-account")).toHaveValue("adapark")
    await app.beat(600)
    await app.type(page.getByTestId("signup-name"), "Ada Park")
    await app.click(page.getByTestId("signup-account-continue"))

    const question = page.getByTestId("signup-question")
    await expect(question).toHaveAttribute("data-question", "size")
    await app.beat(900)
    await app.click(question.getByRole("radio", { name: /11/ }))
    await expect(question).toHaveAttribute("data-question", "role")
    await app.click(question.getByRole("radio", { name: /Engineering/ }))
    await expect(question).toHaveAttribute("data-question", "heard")
    await app.click(page.getByTestId("signup-skip"))
    await expect(question).toHaveAttribute("data-question", "know")
    await app.click(question.getByRole("radio", { name: /Yes/ }))
    await expect(question).toHaveAttribute("data-question", "models")
    await app.click(question.getByRole("checkbox", { name: /Claude/ }))
    await app.click(page.getByTestId("signup-continue"))
    await expect(question).toHaveAttribute("data-question", "repo")
    await app.beat(600)
    await app.click(page.getByTestId("signup-new-repo"))
    await expect(question).toHaveAttribute("data-question", "more")
    await app.click(page.getByTestId("signup-skip"))

    await expect(page.getByTestId("signup-finish")).toBeVisible()
    await expect(signup).toContainText("smithers.sh/adapark")
    await app.beat(1200)
    await app.click(page.getByTestId("signup-finish"))
    await expect(signup).toHaveCount(0)
    await expect(page.getByTestId("setup-checklist")).toBeVisible()
  }
})
