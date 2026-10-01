/*
 * The Models surface as a user drives it: the card, its rows, the model.save
 * form and the seats table. A rename in the DOM contract is absorbed here.
 *
 * The loopback provider is owned by scripts/run-real-e2e.ts, because a custom
 * credential is pinned to the origin its env pair declared before the host
 * booted. This file reads that origin and the provider's journal; it never
 * launches, configures or stops the provider.
 */
import type { Locator, Page } from "@playwright/test"
import { createHash } from "node:crypto"
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import {
  MODEL_CREDENTIAL_ENV_PREFIX, MODEL_CREDENTIAL_ORIGIN_SUFFIX, ModelTestFailureSchema,
  type ModelProtocol, type ModelTestFailure
} from "@smthrs/rpc/ConfiguredModel"
import { PROVIDER_PATHS, type ProviderJournalEntry } from "../support/model-provider-behaviors"
import { runnerCredential } from "../support/model-provider-process"
import { appReady, awaitBoot, closeComposer, command, expect, openApp } from "../support"

/** The credential NAMES the runner declared. The second is a well-formed key the provider answers 401. */
export const ACCEPTED_CREDENTIAL = "E2E_LOOPBACK"
export const REJECTED_CREDENTIAL = "E2E_REVOKED"
export type RunnerCredentialName = typeof ACCEPTED_CREDENTIAL | typeof REJECTED_CREDENTIAL

export interface ModelDraft {
  readonly name: string
  readonly protocol: ModelProtocol
  readonly baseUrl?: string
  readonly modelId: string
  readonly credential: string
}

/** The origin the runner pinned both credentials to: what a user types as Base URL. */
export const providerOrigin = (): string => {
  const origin = process.env[`${MODEL_CREDENTIAL_ENV_PREFIX}${ACCEPTED_CREDENTIAL}${MODEL_CREDENTIAL_ORIGIN_SUFFIX}`]
  if (!origin) throw new Error("The loopback provider's origin is undeclared. Run through scripts/run-real-e2e.ts, which launches it before the host boots.")
  return origin
}

/** Every request the provider has answered this run, oldest first. */
export const providerJournal = async (): Promise<ReadonlyArray<ProviderJournalEntry>> => {
  const response = await fetch(`${providerOrigin()}${PROVIDER_PATHS.journal}`)
  if (!response.ok) throw new Error(`Provider journal answered ${response.status}`)
  return await response.json() as ReadonlyArray<ProviderJournalEntry>
}

/** What the journal holds in place of a credential. */
export const credentialSha256 = (name: RunnerCredentialName): string =>
  createHash("sha256").update(runnerCredential(name)).digest("hex")

/** A record id: the name is the id, a slug of at most 40 characters. */
export const uniqueName = (label: string): string => `${label}-${Date.now().toString(36)}`

export const boot = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await openApp(page)
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

export const modelsCard = (page: Page): Locator => page.locator('.smithers-card[data-kind="models"]')
export const modelRow = (page: Page, name: string): Locator => modelsCard(page).locator(`[data-model-id="${name}"]`)
export const modelDetail = (page: Page): Locator => modelsCard(page).getByTestId("model-detail")
export const seatSelect = (page: Page, seat: string): Locator => modelsCard(page).locator(`select[data-seat="${seat}"]`)
const saveForm = (page: Page): Locator => page.locator('.flow-form[data-flow-name="model.save"]')

/** `/model.list` (or the bare `/model` door), settled: the host's catalog has answered, so the form offers the host's credential names. */
export const listModels = async (page: Page, door: "/model.list" | "/model" = "/model.list"): Promise<Locator> => {
  const catalog = page.waitForResponse((response) => new URL(response.url()).pathname === MODEL_CATALOG_PATH)
  await command(page, door)
  await closeComposer(page)
  expect((await catalog).status()).toBe(200)
  const card = modelsCard(page)
  await expect(card).toBeVisible()
  await expect(card.getByTestId("models-error")).toHaveCount(0)
  return card
}

/** Fill what the draft names and press Save. The credential is a pick from the host's names, or a text input when it listed none. */
export const fillModelForm = async (page: Page, draft: Partial<ModelDraft>): Promise<void> => {
  const form = saveForm(page)
  await expect(form.getByTestId("flow-form-submit")).toBeVisible()
  if (draft.name !== undefined) await form.getByTestId("flow-form-name").fill(draft.name)
  if (draft.protocol !== undefined) await form.getByTestId("flow-form-protocol").selectOption(draft.protocol)
  if (draft.baseUrl !== undefined) await form.getByTestId("flow-form-baseUrl").fill(draft.baseUrl)
  if (draft.modelId !== undefined) await form.getByTestId("flow-form-modelId").fill(draft.modelId)
  if (draft.credential !== undefined) {
    const credential = form.getByTestId("flow-form-credential")
    if (await credential.evaluate((element) => element.tagName === "SELECT")) await credential.selectOption(draft.credential)
    else await credential.fill(draft.credential)
  }
  await form.getByTestId("flow-form-submit").click()
}

/** The Models card, its New button, the form, Save; resolves to the saved model's row. */
export const createModel = async (page: Page, draft: ModelDraft): Promise<Locator> => {
  const card = await listModels(page)
  await card.getByTestId("model-new").click()
  await fillModelForm(page, draft)
  const row = modelRow(page, draft.name)
  await expect(row).toBeVisible()
  return row
}

/** A settled test as the row states it: the dot's state, then the latency or the typed failure and its fault. */
export type RowTestResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly failure: ModelTestFailure; readonly fault: string }

/** The failure a row draws, back in its typed shape: the code, then the one number or name that code carries. */
const failureOf = (code: string, detail: string | undefined): ModelTestFailure => ModelTestFailureSchema.parse({
  code,
  ...(code === "refused" ? { status: Number(detail) } : {}),
  ...(code === "timeout" ? { deadlineMs: Number(detail?.replace(/ ms$/, "")) } : {}),
  ...(code === "invalid" ? { field: detail } : {}),
  ...(code === "credential_missing" || code === "credential_unknown" ? { credential: detail } : {})
})

/**
 * Press a row's Test and read the settled row. The host answers 200 for both
 * outcomes; the typed result is read from the row, because the page releases
 * a seam response once it has buffered it and the browser then holds no body.
 */
export const testModel = async (page: Page, row: Locator): Promise<RowTestResult> => {
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === MODEL_TEST_PATH, { timeout: 60_000 })
  await row.getByRole("button", { name: "Test", exact: true }).click()
  expect((await answered).status()).toBe(200)
  await expect(row).toHaveAttribute("data-test-state", /^(passed|failed)$/)
  const mark = ((await row.locator(".models-test").textContent()) ?? "").trim()
  if (await row.getAttribute("data-test-state") === "passed") {
    const latency = /^(\d+) ms$/.exec(mark)
    if (latency === null) throw new Error(`A passed row drew ${JSON.stringify(mark)}, not a latency`)
    return { ok: true, latencyMs: Number(latency[1]) }
  }
  const [code, detail] = mark.split(" · ")
  expect(await row.getAttribute("data-failure-code")).toBe(code)
  return { ok: false, failure: failureOf(code!, detail), fault: (await row.getAttribute("data-failure-fault")) ?? "" }
}

/** The composer card of one model: the request's controls and the answer beside them. */
export const composerCard = (page: Page, name: string): Locator =>
  page.locator('.smithers-card[data-kind="model-call"]').filter({ has: page.locator(`[data-testid="model-call"][data-model="${name}"]`) })

/** Compose under `scope` (a row, or the maximized pane's detail), and the composer it opens. */
export const composeModel = async (page: Page, scope: Locator, name: string): Promise<Locator> => {
  await scope.getByRole("button", { name: "Compose", exact: true }).click()
  const composer = composerCard(page, name)
  await expect(composer).toBeVisible()
  return composer
}

/** Press Ask and read the settled answer: the host answers 200 for both outcomes, and the card carries the typed result. */
export const askModel = async (page: Page, composer: Locator): Promise<{ readonly ok: boolean; readonly answers: Readonly<Record<string, string>>; readonly text: string | undefined }> => {
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === MODEL_TEST_PATH, { timeout: 60_000 })
  await composer.getByTestId("model-call-ask").click()
  expect((await answered).status()).toBe(200)
  await expect(composer.getByTestId("model-call")).not.toHaveAttribute("data-asking", "true")
  await expect(composer.getByTestId("model-call-result")).toBeVisible()
  const ok = (await composer.getByTestId("model-call-result").getAttribute("data-ok")) === "true"
  const answers: Record<string, string> = {}
  for (const question of await composer.locator("[data-question]").all()) {
    const id = await question.getAttribute("data-question")
    const answer = question.getByTestId("model-call-answer")
    if (id !== null && await answer.count() > 0) answers[id] = ((await answer.textContent()) ?? "").trim()
  }
  const text = composer.getByTestId("model-call-text")
  return { ok, answers, text: await text.count() > 0 ? ((await text.textContent()) ?? "") : undefined }
}

/** The pane, however the card stands: a maximized card is still maximized after a reload. */
export const maximize = async (page: Page): Promise<void> => {
  const card = modelsCard(page)
  if (await card.getAttribute("data-maximized") !== "true") await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
}

/** A maximized card survives navigation in a shared window; hand the next scenario an unobstructed page. */
export const restore = async (page: Page): Promise<void> => {
  const card = modelsCard(page)
  if (await card.getAttribute("data-maximized") === "true") await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(card).not.toHaveAttribute("data-maximized", "true")
}

/** How long a turn's open stream is waited for. A sealed turn ends with its answer; one that never ends is read as far as it got. */
const STREAM_READ_MS = 20_000

interface TurnBodies { readonly bodies: Array<string>; open: number }

/**
 * Everything that crossed between this page and its host, both directions:
 * each request's URL, headers and body, and each API response's body. A turn's
 * frames are the one body that carries a provider's words, and the browser
 * keeps no copy of a streamed body for the debugger to hand over, so the page
 * reads its own copy of each as it arrives. A credential value must be in none
 * of it. Call before the first navigation.
 */
export const captureTraffic = (page: Page): { readonly read: () => Promise<string> } => {
  const seen: Array<Promise<string>> = []
  page.on("request", (request) => {
    seen.push(Promise.resolve(`${request.url()}\n${JSON.stringify(request.headers())}\n${request.postData() ?? ""}`))
  })
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.startsWith("/api/")) return
    if (!(response.headers()["content-type"] ?? "").includes("application/json")) return
    seen.push(response.text().catch(() => ""))
  })
  const watching = page.addInitScript(() => {
    const turns: TurnBodies = { bodies: [], open: 0 }
    Object.assign(window, { __turnBodies: turns })
    const send = window.fetch.bind(window)
    const watched = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const response = await send(...args)
      if ((response.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
        const copy = response.clone().body?.getReader()
        const decoder = new TextDecoder()
        const at = turns.bodies.push("") - 1
        turns.open += 1
        const pump = async (): Promise<void> => {
          for (let part = await copy?.read(); part !== undefined && !part.done; part = await copy?.read()) {
            turns.bodies[at] += decoder.decode(part.value, { stream: true })
          }
        }
        void pump().catch(() => {}).finally(() => { turns.open -= 1 })
      }
      return response
    }
    Object.assign(window, { fetch: watched })
  })
  return {
    read: async () => {
      await watching
      const turns = (): TurnBodies => (window as unknown as { __turnBodies: TurnBodies }).__turnBodies
      await page.waitForFunction(() => (window as unknown as { __turnBodies?: TurnBodies }).__turnBodies?.open === 0, undefined, { timeout: STREAM_READ_MS }).catch(() => {})
      const frames = await page.evaluate(turns).then((value) => value.bodies, (): Array<string> => [])
      return [...await Promise.all(seen), ...frames].join("\n")
    }
  }
}

/** The rendered document plus the page's own string storage. */
export const pageText = async (page: Page): Promise<string> =>
  `${await page.content()}\n${await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))}`
