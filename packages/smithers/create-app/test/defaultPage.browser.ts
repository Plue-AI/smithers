import type * as ModelEvent from "@smthrs/model/ModelEvent"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { TurnFrame } from "../src/ui.ts"
import type { Env } from "../template/default/worker/handle.ts"

const template = fileURLToPath(new URL("../template/default/", import.meta.url))
const answer = "The card explains what durable execution buys you."
const pagePath = join(template, "app/page.tsx")
// Pin the page before loading the host: another checkout update must not change
// the browser's source halfway through this regression.
const pageSource = readFileSync(pagePath, "utf8")
const pageHash = createHash("sha256").update(pageSource).digest("hex")
const [
  ScriptedJudge,
  QuickJSSandbox,
  { make: makeModel },
  { ModelError },
  { Fixture },
  RecordedModel,
  Effect,
  Schema,
  Stream,
  { chromium },
  { createServer: createViteServer },
  { preparedRequest, replayModelError },
  { handle }
] = await Promise.all([
  import("@smthrs/agent/ScriptedJudge"),
  import("@smthrs/harness/QuickJSSandbox"),
  import("@smthrs/model/Model"),
  import("@smthrs/model/ModelError"),
  import("@smthrs/testing/Fixture"),
  import("@smthrs/testing/RecordedModel"),
  import("effect/Effect"),
  import("effect/Schema"),
  import("effect/Stream"),
  import("playwright"),
  import("vite"),
  import("../src/testing.ts"),
  import("../template/default/worker/handle.ts")
])

const importedAt = performance.now()
for (const failure of [false, true]) {
  test(
    `default chat keeps cell source out of the answer (${failure ? "failure" : "success"})`,
    { timeout: 120_000 },
    async (t) => {
      t.diagnostic(`Page SHA256: ${pageHash}; harness imports: ${Math.round(importedAt)} ms`)
      const cacheDir = mkdtempSync(join(tmpdir(), "smithers-2675-vite-"))
      let cleanup = async (): Promise<void> => {}
      t.after(async () => {
        try {
          await cleanup()
        } finally {
          rmSync(cacheDir, { recursive: true, force: true })
        }
      })
      const fixture = Schema.decodeUnknownSync(Fixture)(
        JSON.parse(
          readFileSync(new URL("../template/default/flows/chat/fixtures/answer.json", import.meta.url), "utf8")
        )
      )
      const replay = await Effect.runPromise(RecordedModel.make(fixture))
      let modelCalls = 0
      let releaseModel = () => {}
      const modelGate = new Promise<void>((resolve) => {
        releaseModel = resolve
      })
      let modelStarted = () => {}
      const started = new Promise<void>((resolve) => {
        modelStarted = resolve
      })
      const model = makeModel({
        stream: (request) =>
          failure
            ? Stream.concat(
              Stream.fromArray<ModelEvent.ModelEvent>([
                { type: "text-start", id: "cell" },
                { type: "text-delta", id: "cell", text: "```cell\nawait ctx.done({ answer: 'uncommitted' })\n```" }
              ]),
              Stream.fail(new ModelError({ code: "authentication", message: "Controlled model failure" }))
            )
            : Stream.unwrap(Effect.promise(async () => {
              modelCalls++
              modelStarted()
              await modelGate
              return replay.model.stream(request).pipe(
                Stream.mapError(replayModelError),
                Stream.map((event): ModelEvent.ModelEvent => event)
              )
            }))
      })
      const seats = {
        resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } })
      }
      const env: Env = {
        APP_NAME: "app",
        APP_API_TOKEN: "s3cret",
        ASSETS: { fetch: async () => new Response("unused") }
      }
      const vite = await createViteServer({
        root: template,
        cacheDir,
        configFile: false,
        resolve: {
          alias: {
            "@smthrs/create-app/app": fileURLToPath(new URL("../src/app.ts", import.meta.url)),
            "@smthrs/create-app/ui": fileURLToPath(new URL("../src/ui.ts", import.meta.url))
          }
        },
        plugins: [{
          name: "test-template-virtuals",
          resolveId: (id) => id.startsWith("virtual:smthrs-app/") ? `\0${id}` : undefined,
          load: (id) =>
            id.split("?")[0] === pagePath ? pageSource : id === "\0virtual:smthrs-app/brand.css" ?
              "" :
              id === "\0virtual:smthrs-app/manifest"
              ? "export default { brand: { name: 'app' }, nav: [] }"
              : undefined
        }],
        server: { middlewareMode: true, hmr: false, ws: false }
      })
      let frames: ReadonlyArray<TurnFrame> = []
      let requests = 0
      let releaseTerminal = () => {}
      const terminalGate = new Promise<void>((resolve) => {
        releaseTerminal = resolve
      })
      const server = createHttpServer(async (request, response) => {
        if (request.url !== "/api/turn") {
          vite.middlewares(request, response)
          return
        }
        requests++
        try {
          const chunks: Array<Uint8Array> = []
          for await (const chunk of request) chunks.push(chunk)
          const result = await handle(
            new Request("http://localhost/api/turn", {
              method: "POST",
              headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
              body: Buffer.concat(chunks)
            }),
            env,
            QuickJSSandbox.layerVariantLive,
            { seats, evaluator: ScriptedJudge.layer }
          )
          response.writeHead(result.status, Object.fromEntries(result.headers))
          const body = await result.text()
          frames = body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TurnFrame)
          if (failure) response.end(body)
          else {
            response.write(frames.slice(0, -1).map((frame) => JSON.stringify(frame) + "\n").join(""))
            await terminalGate
            response.end(JSON.stringify(frames.at(-1)) + "\n")
          }
        } catch (error) {
          if (!response.headersSent) response.writeHead(500)
          response.end(String(error))
        }
      })
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      cleanup = async () => {
        releaseModel()
        releaseTerminal()
        await browser?.close()
        server.closeAllConnections()
        await vite.close()
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error === undefined ? resolve() : reject(error))
          })
        }
      }
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("HTTP server has no port")
      const executablePath = process.env.SMITHERS_CHROME_PATH
      browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/`)
      await page.evaluate(() => sessionStorage.setItem("app.api-token", "s3cret"))
      await page.locator(".composer-input").fill("What does durable execution buy me?")
      await page.locator(".composer-send").click()
      if (!failure) {
        await started
        assert.equal(await page.locator(".composer-send").isDisabled(), true)
        await page.locator(".composer-input").press("Enter")
        await page.locator(".composer-input").press("Enter")
        await page.waitForTimeout(200)
        assert.equal(requests, 1)
        assert.equal(modelCalls, 1)
        releaseModel()
        await page.locator(".pane-heading").waitFor()
        assert.equal(await page.locator(".answer-text").count(), 0)
        releaseTerminal()
      }
      await page.waitForFunction(() => document.querySelector(".composer-send")?.textContent === "Send")

      assert.ok(frames.some((frame) => frame.type === "delta" && frame.text.includes("await ctx.done")))
      if (failure) {
        const terminal = frames.at(-1)
        assert.ok(terminal?.type === "error")
        assert.equal(await page.locator(".answer-error").textContent(), terminal.message)
        assert.equal(await page.locator(".answer-text").count(), 0)
        const retried = page.waitForResponse((response) => response.url().endsWith("/api/turn"))
        await page.locator(".composer-input").press("Enter")
        await retried
        assert.equal(requests, 2)
      } else {
        assert.deepEqual(frames.at(-1), {
          type: "done",
          output: { answer, cards: frames.flatMap((frame) => frame.type === "card" ? [frame.card.id] : []) }
        })
        assert.equal(await page.locator(".pane-heading").textContent(), "Durable execution")
        assert.equal(await page.locator(".answer-text").textContent(), answer)
      }
    }
  )
}
