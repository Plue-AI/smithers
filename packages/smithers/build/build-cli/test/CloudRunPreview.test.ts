import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterAll, describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import { tar } from "./helpers/OciArchive.ts"
import { serve } from "./helpers/ServeCli.ts"

const roots: Array<string> = []
const servers: Array<Http.Server> = []
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const digest = `sha256:${"d".repeat(64)}`
const token = "fixture-secret-token"
interface Call {
  tool: string
  argv: Array<string>
  config?: string
  configMode?: number
  stdin: string
  cloud: Array<string>
  cache: boolean
}

const fixture = async (options: {
  access?: string
  stale?: boolean
  missingService?: boolean
  missingTool?: "docker" | "gcloud"
  pushFails?: boolean
  loginFails?: boolean
  authFails?: boolean
  malformedService?: boolean
  architecture?: string
  reuseExpires?: string
  reuseDigest?: string
  env?: Record<string, string>
  unresolvedTraffic?: boolean
  latestTraffic?: boolean
  disconnect?: boolean
  disappearDocker?: boolean
  tokenOverflow?: boolean
  corruptArchive?: boolean
  approval?: "required"
  removeFails?: boolean
  deleteFails?: boolean
  pendingPush?: boolean
  pendingDeploy?: boolean
  reconcileFails?: boolean
  deployFails?: boolean
  postDescribeFails?: boolean
  postDescribeMalformed?: boolean
  foreignLabeled?: boolean
  status?: number
} = {}) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "cloud-run-preview-")))
  roots.push(root)
  await Fs.mkdir(Path.join(root, ".smithers"))
  await Fs.writeFile(
    Path.join(root, "package.json"),
    "{\"name\":\"preview-fixture\",\"private\":true,\"packageManager\":\"pnpm@11.25.0\"}"
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.writeFile(Path.join(root, "Dockerfile"), "FROM scratch\n")
  await Fs.writeFile(
    Path.join(root, ".smithers/WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("preview-fixture", {
repository: "git+https://example.invalid/preview.git", cache: S.Cache({ directory: ".flows" }),
runtime: S.Runtime.Node({ version: ">=26.4.0" }),
packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }), host: S.Host({ bins: ["docker", "gcloud"] }) })`
  )
  await Fs.writeFile(
    Path.join(root, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const image = S.Docker.Build({ dockerfile: S.file("Dockerfile"), context: ".", platforms: ["linux/amd64"] })
const preview = S.CloudRun.Preview({ image, project: "fixture-project", region: "us-central1", service: "fixture",
repository: "us-central1-docker.pkg.dev/fixture-project/previews", deployer: "deployer@fixture-project.iam.gserviceaccount.com",
serviceAccount: "runtime@fixture-project.iam.gserviceaccount.com", access: ${
      JSON.stringify(options.access ?? "private")
    }, env: ${JSON.stringify(options.env ?? { VALUE: "a,b=c" })}${
      options.approval === undefined ? "" : ", approval: \"required\""
    } })
export const Package = S.Package({ targets: { image, preview } })`
  )
  for (
    const args of [["init", "-q"], ["add", "."], [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture"
    ]]
  ) {
    expect(spawnSync("git", args, { cwd: root }).status).toBe(0)
  }
  expect(spawnSync("git", ["remote", "add", "origin", "https://example.invalid/preview.git"], { cwd: root }).status)
    .toBe(0)
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim()
  const config = JSON.stringify({
    architecture: options.architecture ?? "amd64",
    os: "linux",
    config: { Labels: { "org.opencontainers.image.revision": options.stale ? "0".repeat(40) : commit } },
    rootfs: { type: "layers", diff_ids: [] }
  })
  const hash = (body: string) => createHash("sha256").update(body).digest("hex")
  const configDigest = `sha256:${hash(config)}`
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest }, layers: [] })
  const archive = Path.join(root, "fixture.tar")
  await Fs.writeFile(
    archive,
    tar([
      {
        name: "index.json",
        body: JSON.stringify({
          manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${hash(manifest)}` }]
        })
      },
      { name: `blobs/sha256/${hash(config)}`, body: config },
      { name: `blobs/sha256/${hash(manifest)}`, body: manifest }
    ])
  )
  if (options.corruptArchive) await Fs.writeFile(archive, "not an OCI archive")
  const server = Http.createServer((_request, response) => {
    if (options.disconnect) {
      _request.socket.destroy()
      return
    }
    response.writeHead(options.status ?? 403)
    response.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const bin = Path.join(root, "bin")
  await Fs.mkdir(bin)
  await Fs.symlink(process.execPath, Path.join(bin, "node"))
  const pnpm = spawnSync("/usr/bin/which", ["pnpm"], { encoding: "utf8" }).stdout.trim()
  if (pnpm !== "") await Fs.symlink(pnpm, Path.join(bin, "pnpm"))
  const log = Path.join(root, "calls.jsonl")
  const state = Path.join(root, "deployed")
  const script = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), tool = path.basename(process.argv[1]);
let stdin = ""; const run = () => {
fs.appendFileSync(${
    JSON.stringify(log)
  }, JSON.stringify({ tool, argv, stdin, config: process.env.DOCKER_CONFIG, configMode: process.env.DOCKER_CONFIG ? fs.statSync(process.env.DOCKER_CONFIG).mode & 511 : undefined, cache: Boolean(process.env.SMITHERS_CACHE_TOKEN), cloud: Object.keys(process.env).filter(k => k.startsWith("CLOUDSDK_")) }) + "\\n");
if (tool === "docker") {
 if (argv[0] === "buildx" && argv[1] === "build") { const dest = argv.find(a => a.startsWith("type=oci,dest=")).slice(14); fs.mkdirSync(path.dirname(dest), {recursive:true}); fs.copyFileSync(${
    JSON.stringify(archive)
  }, dest); }
 else if (argv[0] === "login") { console.log(stdin); console.error(stdin); ${
    options.loginFails ? "process.exit(23);" : ""
  } }
 else if (argv[0] === "load") console.log("Loaded image ID: ${configDigest}");
 else if (argv[0] === "push") { ${
    options.pendingPush
      ? `require("node:child_process").spawn(process.execPath, ["-e", ${
        JSON.stringify(
          `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${
            JSON.stringify(Path.join(root, "push-descendant"))
          }, String(process.pid)); setInterval(() => {}, 1000);`
        )
      }], { stdio: "ignore" }); setInterval(() => {}, 1000); return;`
      : options.pushFails
      ? "process.exit(23);"
      : `console.log("r: digest: ${digest} size: 1");`
  } }
 else if (argv[1] === "imagetools") console.log(JSON.stringify({config:{digest:"${configDigest}"}}));
 else console.log("fixture engine");
} else {
 if (argv[0] === "auth") {
  ${options.disappearDocker ? `fs.unlinkSync(${JSON.stringify(Path.join(bin, "docker"))});` : ""}
  console.log(${options.tokenOverflow ? "\"x\".repeat(17 * 1024 * 1024)" : JSON.stringify(token)});
  ${options.authFails ? "process.exit(23);" : ""}
 }
 else if (argv[2] === "update-traffic" && ${options.removeFails === true}) process.exit(23);
 else if (argv[2] === "delete" && ${options.deleteFails === true}) process.exit(23);
 else if (argv[1] === "deploy") { fs.writeFileSync(${JSON.stringify(state)}, String(Number(fs.existsSync(${
    JSON.stringify(state)
  }) ? fs.readFileSync(${JSON.stringify(state)}, "utf8") : 0) + 1)); fs.writeFileSync(${
    JSON.stringify(Path.join(root, "labels"))
  }, argv[argv.indexOf("--labels") + 1]); ${options.deployFails ? "process.exit(23);" : ""} ${
    options.pendingDeploy ? "setInterval(() => {}, 1000);" : ""
  } }
 else if (argv[1] === "services" && argv[2] === "describe") {
  if (fs.existsSync(${JSON.stringify(state)})) { ${options.postDescribeFails ? "process.exit(23);" : ""} ${
    options.postDescribeMalformed ? "console.log('malformed'); process.exit(0);" : ""
  } }
  ${options.missingService ? "process.exit(1);" : ""}
  ${options.malformedService ? `console.log(${JSON.stringify(token)}); process.exit(0);` : ""}
  const kept = [{tag:"old",revisionName:"fixture-expired",percent:0},{tag:"foreign",revisionName:"fixture-foreign",percent:0},${
    JSON.stringify(
      options.unresolvedTraffic
        ? { percent: 100 }
        : options.latestTraffic
        ? { latestRevision: true, percent: 100 }
        : { revisionName: "fixture-serving", percent: 100 }
    )
  }];
  if (fs.existsSync(${
    JSON.stringify(Path.join(root, "promoted"))
  })) kept.push({revisionName:"fixture-current",percent:100});
  console.log(JSON.stringify({ status: { latestReadyRevisionName: ${
    JSON.stringify(options.latestTraffic ? "fixture-serving" : null)
  }, traffic: fs.existsSync(${JSON.stringify(state)}) ? [...kept,{tag:"r-${
    commit.slice(0, 7)
  }",revisionName:Number(fs.readFileSync(${
    JSON.stringify(state)
  }, "utf8")) > 1 ? "fixture-current-2" : "fixture-current",url:${JSON.stringify(url)},percent:0}] : kept } }));
 } else if (argv[1] === "revisions" && argv[2] === "describe") console.log(JSON.stringify({metadata:{labels:{"smthrs-owner": fs.readFileSync(${
    JSON.stringify(Path.join(root, "labels"))
  }, "utf8").split("smthrs-owner=")[1], "smthrs-expires":${
    JSON.stringify(options.reuseExpires ?? String(Math.floor(Date.now() / 1000) + 72 * 3600))
  }}},status:{imageDigest:${JSON.stringify(options.reuseDigest ?? digest)}}}));
 else if (argv[1] === "revisions" && argv[2] === "list") { ${
    options.reconcileFails ? "process.exit(23);" : ""
  } const labels = Object.fromEntries(fs.readFileSync(${
    JSON.stringify(Path.join(root, "labels"))
  }, "utf8").split(",").map(x => x.split("="))); const owner = labels["smthrs-owner"]; console.log(JSON.stringify([
 {metadata:{name:"fixture-current",labels}},
 ...(${
    options.foreignLabeled === true
  } ? [{metadata:{name:"fixture-foreign",labels:{"smthrs-owner":"foreign","smthrs-expires":"1","smthrs-commit":"abcdef0"}}}] : []),
 {metadata:{name:"fixture-expired",labels:{"smthrs-owner":owner,"smthrs-expires":"1","smthrs-commit":"abcdef0"}}},
 {metadata:{name:"fixture-legacy",labels:{"smthrs-expires":"1","smthrs-commit":"abcdef0"}}}, {metadata:{name:"fixture-unlabeled"}}, {metadata:{name:"fixture-serving",labels:{"smthrs-owner":owner,"smthrs-expires":"1","smthrs-commit":"abcdef2"}}}, {metadata:{name:"fixture-live",labels:{"smthrs-owner":owner,"smthrs-expires":"9999999999","smthrs-commit":"abcdef1"}}}
 ])); }
}
}; if (argv[0] === "login") { process.stdin.on("data", b => stdin += b); process.stdin.on("end", run); process.stdin.resume(); } else run();`
  if (options.missingTool !== "docker") await Fs.writeFile(Path.join(bin, "docker"), script, { mode: 0o755 })
  if (options.missingTool !== "gcloud") await Fs.writeFile(Path.join(bin, "gcloud"), script, { mode: 0o755 })
  return {
    root,
    commit,
    configDigest,
    environment: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      CLOUDSDK_AUTH_ACCESS_TOKEN: "ambient-cloud-credential",
      SMITHERS_CACHE_TOKEN: "cache-fixture-secret"
    },
    calls: async (): Promise<Array<Call>> =>
      (await Fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) =>
        JSON.parse(line)
      )
  }
}

describe("CloudRun.Preview through smthrs run", { timeout: 60_000 }, () => {
  it.each([{ deployFails: true }, { postDescribeFails: true }, { postDescribeMalformed: true }])(
    "reconciles and removes an uncertain deployment %j",
    async (options) => {
      const f = await fixture(options)
      const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
      expect(result.exitCode).toBe(1)
      expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(true)
      expect((await f.calls()).some((c) => c.argv.includes("--remove-tags"))).toBe(true)
    }
  )
  it("preserves an expired fully labeled foreign revision", async () => {
    const f = await fixture({ foreignLabeled: true })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const owner = createHash("sha256").update(JSON.stringify([
      "https://example.invalid/preview.git",
      "//:preview",
      "us-central1-docker.pkg.dev/fixture-project/previews/preview"
    ])).digest("hex").slice(0, 40)
    expect((await f.calls()).find((c) => c.argv[1] === "deploy")!.argv.join(" ")).toContain(`smthrs-owner=${owner}`)
    expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-foreign"))).toBe(false)
    expect((await f.calls()).some((c) => c.argv.includes("foreign") || c.argv.includes("fixture-legacy"))).toBe(false)
  })
  it("preserves the deploy error when reconciliation also fails", async () => {
    const f = await fixture({ deployFails: true, reconcileFails: true })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain("gcloud run deploy fixture failed (23)")
    expect(result.output + result.logs).toContain("cleanup failed")
  })
  it("reconciles a cancelled deployment with an independent cleanup signal", async () => {
    const f = await fixture({ pendingDeploy: true })
    const controller = new AbortController()
    const running = serve(f.root, ["run", "//:preview"], { environment: f.environment, signal: controller.signal })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !(await Fs.stat(Path.join(f.root, "labels")).catch(() => undefined))) {
      await delay(20)
    }
    expect(await Fs.stat(Path.join(f.root, "labels"))).toBeDefined()
    controller.abort()
    const result = await running
    expect(result.exitCode).toBe(1)
    expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(true)
  })
  it("admits a CloudRun preview outward-only and validates its written receipt in the flow", async () => {
    const f = await fixture()
    const refused = await serve(f.root, ["run", "//:image", "--outward-only"], { environment: f.environment })
    expect(refused.exitCode).not.toBe(0)
    expect(refused.output + refused.logs).toContain("//:image is not an outward target")
    expect(await f.calls()).toEqual([])
    const result = await serve(f.root, ["run", "//:preview", "--outward-only"], { environment: f.environment })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const validator = new URL("../../../../../flows/preview/flow.ts", import.meta.url).href
    const validated = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "const { validateReceipt } = await import(process.argv[1]); console.log(JSON.stringify(await validateReceipt(process.argv[2], \"//:preview\", process.argv[3])))",
      validator,
      Path.join(f.root, "cloud-run-preview/preview.json"),
      f.commit
    ], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH } })
    expect(validated.status, validated.stderr).toBe(0)
    expect(JSON.parse(validated.stdout)).toEqual({
      revision: f.commit.slice(0, 7),
      expiresAt: expect.any(String),
      access: "private",
      open: {
        command: `gcloud run services proxy fixture --tag r-${
          f.commit.slice(0, 7)
        } --region us-central1 --project fixture-project --port 4100`,
        localUrl: "http://preview.localhost:4100"
      }
    })
    expect((await f.calls()).some((call) => call.tool === "gcloud" && call.argv[1] === "deploy")).toBe(true)
  })

  it("pushes privately, probes, sweeps, writes a credential-free receipt, and reuses without caching", async () => {
    const f = await fixture()
    const before = Date.now()
    const result = await serve(f.root, ["run", "//:preview", "--results-file", "results-first.json"], {
      environment: f.environment
    })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const calls = await f.calls()
    const cloud = calls.filter((c) => c.tool === "gcloud")
    expect(calls.every((c) => c.cache === false)).toBe(true)
    expect(
      cloud.every((c) =>
        c.argv.includes("--impersonate-service-account=deployer@fixture-project.iam.gserviceaccount.com")
      )
    ).toBe(true)
    const deploy = cloud.find((c) => c.argv[1] === "deploy")!
    expect(deploy.argv).toContain("--no-traffic")
    expect(deploy.argv).toContain("--no-allow-unauthenticated")
    expect(deploy.argv).toContain(`us-central1-docker.pkg.dev/fixture-project/previews/preview@${digest}`)
    const login = calls.find((c) => c.argv[0] === "login")!
    expect(login.stdin).toBe(token + "\n")
    expect(login.config).toBeTruthy()
    expect(login.configMode).toBe(0o700)
    expect(await Fs.stat(login.config!).catch(() => undefined)).toBeUndefined()
    expect(calls.filter((c) => c !== login).every((c) => !JSON.stringify(c).includes(token))).toBe(true)
    expect(calls.find((c) => c.argv[1] === "build")!.cloud).toEqual([])
    const receiptText = await Fs.readFile(Path.join(f.root, "cloud-run-preview/preview.json"), "utf8")
    const receipt = JSON.parse(receiptText)
    expect(receipt).toEqual({
      version: 1,
      label: "//:preview",
      commit: f.commit,
      revision: f.commit.slice(0, 7),
      tag: `r-${f.commit.slice(0, 7)}`,
      project: "fixture-project",
      region: "us-central1",
      service: "fixture",
      imageDigest: digest,
      access: "private",
      expiresAt: expect.any(String),
      open: {
        command: `gcloud run services proxy fixture --tag r-${
          f.commit.slice(0, 7)
        } --region us-central1 --project fixture-project --port 4100`,
        localUrl: "http://preview.localhost:4100"
      },
      measured: { imageBytes: expect.any(Number), buildSeconds: expect.any(Number), readySeconds: expect.any(Number) },
      swept: ["fixture-expired"]
    })
    expect(
      result.output + result.logs + receiptText + await Fs.readFile(Path.join(f.root, "results-first.json"), "utf8")
    ).not.toContain(token)
    expect(cloud.some((c) => c.argv.includes("fixture-unlabeled"))).toBe(false)
    expect(cloud.some((c) => c.argv.includes("fixture-serving"))).toBe(false)
    const transport = calls.filter((c) =>
      c.tool === "gcloud" || ["login", "load", "tag", "push"].includes(c.argv[0]!) || c.argv[1] === "imagetools"
    ).map((c) =>
      `${c.tool} ${
        c.argv.slice(
          0,
          c.tool === "gcloud" && c.argv[0] === "run" ? (c.argv[1] === "deploy" ? 2 : 3) : c.argv[0] === "buildx" ? 3 : 1
        ).join(" ")
      }`
    )
    expect(Date.parse(receipt.expiresAt)).toBeGreaterThanOrEqual(before + 72 * 3600_000 - 1000)
    expect(Date.parse(receipt.expiresAt)).toBeLessThanOrEqual(Date.now() + 72 * 3600_000)
    expect(deploy.argv).toContain("^|^VALUE=a,b=c")
    expect(result.logs).toContain(`Preview ${f.commit.slice(0, 7)} ready · private · expires`)
    expect(result.logs).toContain(receipt.open.command)
    expect(result.logs).toContain("http://preview.localhost:4100")
    expect(transport).toEqual([
      "gcloud run services describe",
      "gcloud auth",
      "docker login",
      "docker load",
      "docker tag",
      "docker push",
      "docker buildx imagetools inspect",
      "gcloud run deploy",
      "gcloud run services describe",
      "gcloud run revisions list",
      "gcloud run services describe",
      "gcloud run services update-traffic",
      "gcloud run revisions delete"
    ])
    const second = await serve(f.root, ["run", "//:preview", "--results-file", "results-second.json"], {
      environment: f.environment
    })
    expect(second.exitCode, second.output + second.logs).toBe(0)
    expect((await f.calls()).filter((c) => c.argv[1] === "deploy")).toHaveLength(1)
    expect((await f.calls()).filter((c) => c.argv[0] === "login")).toHaveLength(2)
    const results = JSON.parse(await Fs.readFile(Path.join(f.root, "results-second.json"), "utf8"))
    expect(results.results.find((r: { label: string }) => r.label === "//:preview").status).toBe("ran")
  })
  it.each([
    { access: "public", code: "public_access_off" },
    { stale: true, code: "stale_image" },
    {
      missingService: true,
      code: "service_missing"
    },
    { missingTool: "gcloud" as const, code: "tool_missing" },
    { missingTool: "docker" as const, code: "tool_missing" },
    { architecture: "arm64", code: "stale_image" }
  ])("refuses $code before publishing", async ({ code, ...options }) => {
    const f = await fixture(options)
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain(code)
    if (code === "public_access_off" || code === "tool_missing") expect(await f.calls()).toEqual([])
    expect((await f.calls()).filter((c) => ["login", "push", "auth"].includes(c.argv[0]!) || c.argv[1] === "deploy"))
      .toEqual([])
  })
  it("omits previews from wildcards", async () => {
    const f = await fixture()
    const result = await serve(f.root, ["run", "//..."], { environment: f.environment })
    expect(result.exitCode).toBe(0)
    expect(await f.calls()).toEqual([])
  })
  it("removes login state after a failed push", async () => {
    const f = await fixture({ pushFails: true })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    const login = (await f.calls()).find((c) => c.argv[0] === "login")!
    expect(await Fs.stat(login.config!).catch(() => undefined)).toBeUndefined()
    expect(result.output + result.logs).not.toContain(token)
  })
  it.each([200, 302, 500])("deletes the revision when anonymous access answers %s", async (status) => {
    const f = await fixture({ status })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain("public_surface")
    const calls = await f.calls()
    expect(calls.some((c) => c.argv.includes("--remove-tags") && c.argv.includes(`r-${f.commit.slice(0, 7)}`))).toBe(
      true
    )
    expect(calls.some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(true)
    expect(await Fs.stat(Path.join(f.root, "cloud-run-preview/preview.json")).catch(() => undefined)).toBeUndefined()
  })
  it.each([{ loginFails: true }, { authFails: true }, { malformedService: true }])(
    "withholds echoed credentials on transport failure %j",
    async (options) => {
      const f = await fixture(options)
      const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
      expect(result.exitCode).toBe(1)
      expect(result.output + result.logs).toContain("tool_failed")
      expect(result.output + result.logs).not.toContain(token)
      const login = (await f.calls()).find((c) => c.argv[0] === "login")
      if (login !== undefined) expect(await Fs.stat(login.config!).catch(() => undefined)).toBeUndefined()
      expect((await f.calls()).some((c) => c.argv[1] === "deploy")).toBe(false)
    }
  )
  it.each([{ reuseExpires: "1" }, { reuseExpires: "invalid" }, { reuseDigest: `sha256:${"a".repeat(64)}` }])(
    "deploys again when the tagged revision cannot be reused %j",
    async (options) => {
      const f = await fixture(options)
      for (let run = 0; run < 2; run++) {
        const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
        expect(result.exitCode, result.output + result.logs).toBe(0)
      }
      expect((await f.calls()).filter((c) => c.argv[1] === "deploy")).toHaveLength(2)
    }
  )
  it("accepts 401 as private proof and clears an empty environment", async () => {
    const f = await fixture({ status: 401, env: {} })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const deploy = (await f.calls()).find((c) => c.argv[1] === "deploy")!
    expect(deploy.argv[deploy.argv.indexOf("--set-env-vars") + 1]).toBe("")
  })
  it.each([{ unresolvedTraffic: true, swept: [] }, { latestTraffic: true, swept: ["fixture-expired"] }])(
    "preserves traffic when the service uses an indirect revision %j",
    async ({ swept, ...options }) => {
      const f = await fixture(options)
      const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
      expect(result.exitCode, result.output + result.logs).toBe(0)
      const receipt = JSON.parse(await Fs.readFile(Path.join(f.root, "cloud-run-preview/preview.json"), "utf8"))
      expect(receipt.swept).toEqual(swept)
      expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-serving"))).toBe(false)
    }
  )
  it.each([{ disappearDocker: true }, { tokenOverflow: true }])(
    "settles failed credential transport and removes temporary state %j",
    async (options) => {
      const f = await fixture(options)
      const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
      expect(result.exitCode).toBe(1)
      expect(result.output + result.logs).toContain("tool_failed")
      expect(result.output + result.logs).not.toContain(token)
      expect((await f.calls()).some((c) => c.argv[1] === "deploy")).toBe(false)
    }
  )
  it("removes a preview whose anonymous probe cannot connect", async () => {
    const f = await fixture({ disconnect: true })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain("public_surface")
    expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(true)
  })
  it("escapes commas, equals signs and custom delimiters in environment values", async () => {
    const f = await fixture({ env: { VALUE: "a|b,c=d" } })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect((await f.calls()).find((c) => c.argv[1] === "deploy")!.argv).toContain("^||^VALUE=a|b,c=d")
  })
  it("refuses a corrupt archive before acquiring a token", async () => {
    const f = await fixture({ corruptArchive: true })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain("stale_image")
    expect((await f.calls()).some((c) => c.tool === "gcloud")).toBe(false)
  })
  it("honors opt-in approval for a private preview", async () => {
    const f = await fixture({ approval: "required" })
    const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(result.exitCode).toBe(1)
    expect(result.output + result.logs).toContain("approval")
    expect((await f.calls()).some((c) => c.argv[0] === "auth" || c.argv[0] === "login" || c.argv[1] === "deploy")).toBe(
      false
    )
  })
  it.each([{ removeFails: true }, { deleteFails: true }])(
    "attempts both cleanup operations and reports a failed privacy cleanup %j",
    async (options) => {
      const f = await fixture({ ...options, status: 200 })
      const result = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
      expect(result.exitCode).toBe(1)
      expect(result.output + result.logs).toContain("public_surface")
      expect(result.output + result.logs).toContain("cleanup failed")
      const calls = await f.calls()
      expect(calls.some((c) => c.argv[2] === "update-traffic")).toBe(true)
      expect(calls.some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(true)
    }
  )
  it("waits for cancellation cleanup before returning from a running push", async () => {
    const f = await fixture({ pendingPush: true })
    const controller = new AbortController()
    const running = serve(f.root, ["run", "//:preview"], { environment: f.environment, signal: controller.signal })
    const deadline = Date.now() + 30_000
    let calls: Array<Call> = []
    while (Date.now() < deadline) {
      calls = await f.calls()
      if (
        calls.some((c) => c.argv[0] === "push") &&
        await Fs.stat(Path.join(f.root, "push-descendant")).catch(() => undefined)
      ) break
      await delay(20)
    }
    const descendant = Number(await Fs.readFile(Path.join(f.root, "push-descendant"), "utf8"))
    controller.abort()
    const result = await running
    expect(calls.some((c) => c.argv[0] === "push")).toBe(true)
    expect(result.exitCode).toBe(1)
    expect(await Fs.stat(calls.find((c) => c.argv[0] === "login")!.config!).catch(() => undefined)).toBeUndefined()
    expect((await f.calls()).some((c) => c.argv[1] === "deploy")).toBe(false)
    expect(result.output + result.logs).not.toContain(token)
    try {
      expect(() => process.kill(descendant, 0), "cancel left the credentialed tool's descendant running").toThrow()
    } finally {
      try {
        process.kill(descendant, "SIGKILL")
      } catch { /* Already reaped by containment. */ }
    }
  })
  it("deploys a new preview when its existing tagged revision has gained traffic", async () => {
    const f = await fixture()
    const first = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(first.exitCode, first.output + first.logs).toBe(0)
    await Fs.writeFile(Path.join(f.root, "promoted"), "yes")
    const second = await serve(f.root, ["run", "//:preview"], { environment: f.environment })
    expect(second.exitCode, second.output + second.logs).toBe(0)
    expect((await f.calls()).filter((c) => c.argv[1] === "deploy")).toHaveLength(2)
    expect((await f.calls()).some((c) => c.argv[2] === "delete" && c.argv.includes("fixture-current"))).toBe(false)
  })
})

// The shared transport's public callback boundary also accepts providers that
// report failure without diagnostics, or success without a capture. Fakes are
// required here: these assertions must neither push an image nor contact Google.
describe("shared archive push transport", () => {
  it("refuses an empty reference list without reading or invoking a transport", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const result = await DockerExec.pushArchive({
      archive: "/absent/image.tar",
      docker: ["docker"],
      repository: "registry.test/image",
      references: [],
      temporaryDirectory: "/absent",
      run: async (argv) => {
        calls.push(argv)
        return { ok: true }
      }
    })
    expect(result).toEqual({ error: "docker push planned no commands" })
    expect(calls).toEqual([])
  })
  it.each([
    { step: "load", error: "docker load failed", missingCapture: false },
    { step: "tag", error: "docker tag failed", missingCapture: false },
    { step: "push", error: "docker push failed", missingCapture: false },
    { step: "inspect", error: "docker buildx imagetools inspect failed", missingCapture: false },
    { step: "load", error: "did not load", missingCapture: true },
    { step: "push", error: "reported no digest", missingCapture: true },
    { step: "inspect", error: "holds config (none)", missingCapture: true }
  ])("fails closed on $step with missingCapture=$missingCapture", async ({ step, error, missingCapture }) => {
    const f = await fixture()
    const temporary = Path.join(f.root, "load")
    const result = await DockerExec.pushArchive({
      archive: Path.join(f.root, "fixture.tar"),
      docker: ["docker"],
      repository: "registry.test/image",
      references: ["registry.test/image:one"],
      temporaryDirectory: temporary,
      run: async (argv) => {
        const command = argv[1] === "buildx" ? "inspect" : argv[1]
        if (command === step) return { ok: missingCapture }
        const stdout = command === "load"
          ? `Loaded image ID: ${f.configDigest}`
          : command === "push"
          ? `one: digest: ${digest} size: 1`
          : command === "inspect"
          ? JSON.stringify({ config: { digest: f.configDigest } })
          : ""
        return { ok: true, result: { stdout } }
      }
    })
    expect(result).toMatchObject({ error: expect.stringContaining(error) })
    expect(await Fs.readdir(temporary)).toEqual([])
    expect(await f.calls()).toEqual([])
  })
})
