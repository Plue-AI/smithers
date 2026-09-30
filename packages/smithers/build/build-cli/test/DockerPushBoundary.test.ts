import * as Stamp from "@smthrs/targets/Stamp"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import type * as HostProbes from "../src/internal/HostProbes.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { imageArchive, tar } from "./helpers/OciArchive.ts"
import { serve } from "./helpers/ServeCli.ts"

const directories: Array<string> = []
const installedDocker = PackageTree.findOnPath("docker")
let planningPath: string
beforeAll(async () => {
  planningPath = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-host-"))
  directories.push(planningPath)
  await Fs.writeFile(Path.join(planningPath, "docker"), "#!/bin/sh\nexit 97\n", { mode: 0o755 })
})
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

// Host availability is the only modeled boundary. Planning and tag rendering
// stay real; actual Docker parsing below never receives a reachable daemon.
const healthyProbes: HostProbes.HostProbes = {
  once: async <A>(key: ReadonlyArray<unknown>): Promise<A> => {
    expect([["--version"], ["info", "--format", "{{.ServerVersion}}"], ["buildx", "ls"]]).toContainEqual(key[2])
    return { exitCode: 0, output: "fixture engine" } as A
  }
}
const plan = (tags: ReadonlyArray<unknown>) =>
  DockerExec.plan({
    rule: "Docker.Push",
    packagePath: "images",
    attrs: { registry: "127.0.0.1:1", name: "fixture", tags } as never,
    environment: { PATH: planningPath },
    probes: healthyProbes
  })

describe("Docker push public boundary", () => {
  it("defers real public stamps until execution", async () => {
    for (const stamp of [Stamp.commit, Stamp.buildTime, Stamp.versionMeta]) {
      const planned = await plan([stamp])
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.[0]?.at(-1)).toContain("{smthrs:stamp:")
    }
  })
  for (const tag of [" ", "bad:tag", "bad/tag", ".bad", "a".repeat(129), "one\n", "one\r\n"]) {
    it(`refuses invalid literal Docker tag ${JSON.stringify(tag)}`, async () => {
      const planned = await plan([tag])
      expect.soft(planned.refusal).toBeTruthy()
      expect(planned.commands).toBeUndefined()
    })
  }
  for (const tag of ["a", "_", "A-0._", "a".repeat(128)]) {
    it(`accepts valid Docker tag boundary ${JSON.stringify(tag)}`, async () => {
      const planned = await plan([tag])
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.[0]?.at(-1)).toBe(`127.0.0.1:1/fixture:${tag}`)
    })
  }
  it("keeps one image argument per command in declaration order", async () => {
    for (const tags of [["latest"], ["two", "one", "two"]]) {
      const planned = await plan(tags)
      expect(planned.refusal).toBeUndefined()
      expect(planned.commands?.map((command) => command.slice(1))).toEqual(
        tags.map((tag) => ["push", `127.0.0.1:1/fixture:${tag}`])
      )
      expect(planned.argv).toEqual(planned.commands?.[0])
      expect(planned.outDirs).toEqual([])
    }
  })

  const refusedTags: ReadonlyArray<ReadonlyArray<unknown>> = [[], [{ unresolved: true }], [""], ["one", ""], [
    "",
    "one"
  ]]
  for (const tags of refusedTags) {
    it(`refuses all commands for unresolved or empty tags ${JSON.stringify(tags)}`, async () => {
      const planned = await plan(tags)
      expect.soft(planned.refusal).toBeTruthy()
      if (tags.includes("")) expect.soft(planned.refusal).toBe("Docker.Push requires a non-empty value for every tag")
      expect.soft(planned.argv).toBeUndefined()
      expect(planned.commands).toBeUndefined()
    })
  }

  it.skipIf(installedDocker === undefined)(
    "passes every image through installed Docker parsing without contacting a registry",
    async () => {
      const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-parser-"))
      directories.push(directory)
      const planned = await plan(["one", "two"])
      expect(planned.commands).toHaveLength(2)
      for (const command of planned.commands!) {
        const result = spawnSync(installedDocker!, command.slice(1), {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, DOCKER_HOST: `unix://${Path.join(directory, "missing.sock")}`, DOCKER_CONTEXT: "" }
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(`${result.stdout}${result.stderr}`).toContain("missing.sock")
        expect(`${result.stdout}${result.stderr}`).not.toMatch(/requires exactly|invalid reference format/)
      }
    }
  )

  for (const args of [["//:dockerPush", "--plan"], ["//:dockerPush"]]) {
    it(`refuses approval through the public CLI ${args.join(" ")}`, async () => {
      const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-approval-"))
      directories.push(root)
      await Fs.cp(Path.join(import.meta.dirname, "fixtures/chain-exec"), root, { recursive: true })
      const packageFile = Path.join(root, "PACKAGE.ts")
      const source = await Fs.readFile(packageFile, "utf8")
      const secretDeclaration =
        "secrets: [S.HttpSecret(S.Secret(\"CHAIN_DOCKER_TOKEN\"), [\"https://registry-1.docker.io\"])],"
      expect(source).toContain(secretDeclaration)
      expect(source).toContain("tags: [\"latest\"]")
      await Fs.writeFile(
        packageFile,
        source
          .replace("tags: [\"latest\"]", "tags: [\"two\", \"one\"]")
          .replace(
            "secrets: [S.HttpSecret(S.Secret(\"CHAIN_DOCKER_TOKEN\"), [\"https://registry-1.docker.io\"])],",
            "secrets: [],"
          )
      )
      const bin = Path.join(root, "controlled-bin")
      await Fs.mkdir(bin)
      const calls = Path.join(root, "docker-calls.txt")
      await Fs.writeFile(
        Path.join(bin, "docker"),
        `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
--version|info|buildx) echo 'fixture engine';;
*) exit 97;;
esac
`,
        { mode: 0o755 }
      )
      const result = await serve(root, args, {
        environment: { ...process.env, PATH: `${bin}${Path.delimiter}${process.env["PATH"] ?? ""}` }
      })
      expect(`${result.output}${result.logs}`).toContain("approval required")
      expect(result.exitCode).toBe(args.includes("--plan") ? 0 : 1)
      // A successful inert plan is not approval or successful execution.
      if (args.includes("--plan")) {
        expect(result.output).toContain("registry.example.invalid/fixture:two")
        expect(result.output).toContain("registry.example.invalid/fixture:one")
        expect(result.output).toContain("commands")
      }
      expect(`${result.output}${result.logs}`).not.toContain("docker daemon did not answer")
      const observed = await Fs.readFile(calls, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      expect(observed.split("\n").filter((line) => line.startsWith("push"))).toEqual([])
      expect(observed.split("\n")).toEqual(expect.arrayContaining([
        "--version",
        "info --format {{.ServerVersion}}",
        "buildx ls"
      ]))
    })
  }
})

describe("Docker push image archive", () => {
  const archivePath = async (bytes: Buffer): Promise<string> => {
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-push-archive-"))
    directories.push(directory)
    const path = Path.join(directory, "image.tar")
    await Fs.writeFile(path, bytes)
    return path
  }
  const read = async (options: Parameters<typeof imageArchive>[0]) => {
    const archive = imageArchive(options)
    return { read: await DockerExec.readImageArchive(await archivePath(archive.bytes)), images: archive.images }
  }

  it("names the archive a build writes into its output directory", () => {
    expect(DockerExec.imageArchive("images/docker-image")).toBe("images/docker-image/image.tar")
  })
  for (
    const options of [
      {},
      { attestation: true },
      { nested: true },
      { nested: true, attestation: true },
      { pax: true },
      { dockerManifest: true }
    ]
  ) {
    it(`reads the one image of ${JSON.stringify(options)}`, async () => {
      const { images, read: image } = await read(options)
      expect(image).toMatchObject({
        manifest: images[0]!.manifest,
        config: images[0]!.config,
        layers: images[0]!.layers,
        loadable: options.dockerManifest === true
      })
    })
  }
  it("reads the ustar prefix, PAX size, directory, legacy type and ./ layouts tar writers use", async () => {
    const good = imageArchive()
    const image = good.images[0]!
    const hex = (digest: string) => digest.slice("sha256:".length)
    const entries = tar([
      { name: "blobs/", body: "", type: "5" },
      { name: "./oci-layout", body: "{}" },
      {
        name: "index.json",
        body: JSON.stringify({
          manifests: [
            { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: image.manifest },
            { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: image.manifest },
            { digest: image.manifest }
          ]
        }),
        type: "\0"
      },
      {
        name: hex(image.manifest),
        prefix: "blobs/sha256",
        body: JSON.stringify({ config: { digest: image.config }, layers: image.layers.map((digest) => ({ digest })) })
      },
      { name: `./blobs/sha256/${hex(image.config)}`, body: "{}", paxSize: true },
      { name: `blobs/sha256/${hex(image.layers[0]!)}`, body: "layer", pax: true, paxSize: true }
    ])
    expect(await DockerExec.readImageArchive(await archivePath(entries))).toMatchObject({
      manifest: image.manifest,
      config: image.config,
      layers: image.layers,
      loadable: false,
      end: entries.length - 1024
    })
  })
  it("refuses a multi-platform archive rather than pushing one platform of it", async () => {
    for (const nested of [false, true]) {
      const { read: image } = await read({ platforms: ["linux/amd64", "linux/arm64"], nested })
      expect(image).toEqual({ error: "Docker.Push publishes one platform image, but the build archive holds 2" })
    }
  })
  it("refuses archives without exactly one well-formed, present image", async () => {
    const index = (manifests: unknown) => JSON.stringify({ schemaVersion: 2, manifests })
    const good = imageArchive()
    const manifest = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: good.images[0]!.manifest
    }
    const cases: ReadonlyArray<readonly [Buffer, string]> = [
      [tar([]), "no index.json"],
      [tar([{ name: "index.json", body: index([]) }]), "holds no image"],
      [tar([{ name: "index.json", body: "null" }]), "holds no image"],
      [tar([{ name: "index.json", body: "{}" }]), "holds no image"],
      [
        (() => {
          const bytes = tar([{ name: "index.json", body: "{}" }])
          bytes.write("zzzzzzzzzzz", 124, "ascii")
          return bytes
        })(),
        "not a complete tar archive"
      ],
      [tar([{ name: "index.json", body: index([{ ...manifest, digest: "sha256:short" }]) }]), "malformed digest"],
      [tar([{ name: "index.json", body: index([manifest]) }]), `no blobs/sha256/${manifest.digest.slice(7)}`],
      [
        tar([
          { name: "index.json", body: index([manifest]) },
          { name: `blobs/sha256/${manifest.digest.slice(7)}`, body: "{\"config\":{\"digest\":\"sha256:0\"}}" }
        ]),
        "image manifest has a malformed digest"
      ],
      [
        tar([
          { name: "index.json", body: index([manifest]) },
          {
            name: `blobs/sha256/${manifest.digest.slice(7)}`,
            body: JSON.stringify({ config: { digest: good.images[0]!.config }, layers: [] })
          }
        ]),
        `no blob ${good.images[0]!.config}`
      ],
      [good.bytes.subarray(0, good.bytes.length - 1024 - 512), "not a complete tar archive"],
      [tar([{ name: "index.json", body: "{" }]), "JSON"]
    ]
    for (const [bytes, message] of cases) {
      const image = await DockerExec.readImageArchive(await archivePath(bytes))
      expect.soft(image, message).toEqual({ error: expect.stringContaining(message) })
    }
  })
  it("appends the manifest.json docker load reads, keeping every OCI entry", async () => {
    const archive = imageArchive({ attestation: true, pax: true })
    const source = await archivePath(archive.bytes)
    const image = await DockerExec.readImageArchive(source)
    if ("error" in image) throw new Error(image.error)
    const destination = `${source}.loadable.tar`
    await DockerExec.writeLoadableArchive(source, destination, image)
    expect(await Fs.readFile(source)).toEqual(archive.bytes)
    const loadable = await DockerExec.readImageArchive(destination)
    expect(loadable).toMatchObject({ manifest: image.manifest, config: image.config, loadable: true })
    const listed = spawnSync("tar", ["-xOf", destination, "manifest.json"], { encoding: "utf8" })
    expect(listed.status, listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([{
      Config: `blobs/sha256/${image.config.slice(7)}`,
      RepoTags: null,
      Layers: image.layers.map((layer) => `blobs/sha256/${layer.slice(7)}`)
    }])
    const names = spawnSync("tar", ["-tf", destination], { encoding: "utf8" }).stdout.trim().split("\n")
    expect(names).toContain("index.json")
    expect(names).toContain(`blobs/sha256/${image.layers[0]!.slice(7)}`)
  })
  for (
    const [output, expected] of [
      ["Loaded image ID: sha256:abc123\n", ["sha256:abc123"]],
      ["Loaded image: registry.invalid/unit:one\n", []],
      ["Loaded image: a:1\r\nLoaded image ID: sha256:def\r\nLoaded image ID: sha256:0\n", ["sha256:def", "sha256:0"]],
      ["", []],
      ["Loading layer 1/2\n", []]
    ] as const
  ) {
    it(`reads the loaded image IDs from ${JSON.stringify(output)}`, () => {
      expect(DockerExec.loadedImageIds(output)).toEqual(expected)
    })
  }
  const hex = "a".repeat(64)
  for (
    const [output, expected] of [
      [`one: digest: sha256:${hex} size: 523\n`, `sha256:${hex}`],
      [`Pushed\none: digest: sha256:${"b".repeat(64)} size: 1\ntwo: digest: sha256:${hex} size: 9\n`, `sha256:${hex}`],
      ["one: digest: sha256:abc size: 1\n", undefined],
      ["", undefined]
    ] as const
  ) {
    it(`reads the pushed digest from ${JSON.stringify(output)}`, () => {
      expect(DockerExec.pushedDigest(output)).toBe(expected)
    })
  }
  for (
    const [raw, expected] of [
      [JSON.stringify({ config: { digest: `sha256:${hex}` } }), `sha256:${hex}`],
      [JSON.stringify({ manifests: [] }), undefined],
      [JSON.stringify({ config: { digest: "sha256:short" } }), undefined],
      ["null", undefined],
      ["not json", undefined]
    ] as const
  ) {
    it(`reads a registry manifest's config from ${raw}`, () => {
      expect(DockerExec.manifestConfig(raw)).toBe(expected)
    })
  }
})
