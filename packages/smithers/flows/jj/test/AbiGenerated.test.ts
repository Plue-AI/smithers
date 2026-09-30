/** Real WASM ABI campaign. A missing committed artifact is a test failure. */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as WasiPreview1 from "../src/browser/WasiPreview1.ts"
import { rootedSyncFs } from "./RootedSyncFs.ts"

interface Abi {
  readonly memory: WebAssembly.Memory
  readonly _initialize: () => void
  readonly flows_jj_alloc: (size: number) => number
  readonly flows_jj_free: (ptr: number, size: number) => void
  readonly flows_jj_call: (ptr: number, length: number) => bigint
}
const parameter = (name: string, fallback: number, maximum: number) => {
  const text = process.env[name] ?? String(fallback)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > maximum) {
    throw new Error(`${name} is outside its unsigned range`)
  }
  return Number(text)
}
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const fileHash = (text: string) => createHash("blake2b512").update(text).digest("hex").slice(0, 10)
const expectedDiff = (before: string) =>
  `diff --git a/generated.txt b/generated.txt\nindex ${fileHash(before)}..${
    fileHash(`${before}changed\n`)
  } 100644\n--- a/generated.txt\n+++ b/generated.txt\n@@ -1,1 +1,2 @@\n ${before}+changed\n`
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const malformed = (response: Record<string, any>) => {
  expect(Object.keys(response)).toEqual(["err"])
  expect(Object.keys(response.err).sort()).toEqual(["code", "command", "message"])
  expect(response.err.code).toBe("unknown")
  expect(response.err.command).toBe("jj")
  expect(response.err.message).toMatch(/^jj: malformed request:/)
}

it(
  "replays hostile bytes through owned WASM buffers and recovers after every failure",
  { timeout: 240_000 },
  async () => {
    const seed = parameter("SMITHERS_ABI_SEED", 20_260_904, 0xffff_ffff)
    const cases = parameter("SMITHERS_ABI_CASES", 256, 100_000)
    const steps = parameter("SMITHERS_ABI_STEPS", 4, 256)
    expect(cases).toBeGreaterThan(0)
    expect(steps).toBeGreaterThan(0)
    const wasmPath = fileURLToPath(new URL("../wasm/flows_jj.wasm", import.meta.url))
    const wasmBytes = new Uint8Array(fs.readFileSync(wasmPath))
    const root = "/repo"
    let state = seed
    const next = () => state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    const nativePath = process.env.SMITHERS_ABI_NATIVE_REPORT
    const inputs: Array<Uint8Array> = nativePath === undefined
      ? Array.from({ length: cases }, (_, index) => {
        if (index % 3 === 0) return Uint8Array.from([0xff, next() & 255])
        if (index % 3 === 1) {
          return encoder.encode(JSON.stringify({ op: "status", root: [0, -1, 2 ** 31, 2 ** 32, 2 ** 53][index % 5] }))
        }
        return encoder.encode(JSON.stringify({ op: `unknown-${next()}`, root }))
      })
      : (() => {
        const native = JSON.parse(fs.readFileSync(nativePath, "utf8"))
        expect(native).toMatchObject({ status: "passed", seed, requestedCases: cases, executedCases: cases })
        expect(native.requests).toHaveLength(cases)
        return native.requests.map((entry: { inputHex: string }) => {
          expect(entry.inputHex).toMatch(/^(?:[a-f0-9]{2})*$/)
          return new Uint8Array(Buffer.from(entry.inputHex, "hex"))
        })
      })()
    const report = {
      schemaVersion: 1,
      tier: "wasm",
      status: "running",
      seed,
      requestedCases: cases,
      requestedSteps: steps,
      executedCases: 0,
      executedSteps: 0,
      healthChecks: 0,
      exchanges: 0,
      wasmSha256: digest(wasmBytes),
      corpusSha256: digest(inputs.map((bytes) => Buffer.from(bytes).toString("hex")).join("\n")),
      initialMemoryBytes: 0,
      peakMemoryBytes: 0,
      currentMemoryBytes: 0,
      allocations: 0,
      frees: 0,
      liveAllocations: 0,
      peakLiveBytes: 0,
      openHostFiles: 0,
      boundaryLengths: [] as Array<number>,
      truncatedLengths: [] as Array<number>,
      rejectedAllocations: [] as Array<number>,
      growthFailures: 0,
      requests: [] as Array<unknown>,
      operations: [] as Array<unknown>,
      pendingInputHex: "",
      failure: ""
    }
    const ledger = new Map<number, number>()
    const files = new Set<number>()
    let host: string | undefined
    let failed = false
    let failure: unknown
    let abi: Abi | undefined
    try {
      host = fs.mkdtempSync(join(tmpdir(), "flows-jj-abi-generated-"))
      fs.mkdirSync(join(host, "repo"))
      const hostFs = rootedSyncFs(host)
      const wasi = WasiPreview1.make({
        fs: {
          ...hostFs,
          openSync: (...args) => {
            const fd = hostFs.openSync(...args)
            expect(files.has(fd)).toBe(false)
            files.add(fd)
            return fd
          },
          closeSync: (fd) => {
            expect(files.delete(fd)).toBe(true)
            hostFs.closeSync(fd)
          }
        }
      })
      const instance = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: { ...wasi.imports } })
      abi = instance.instance.exports as unknown as Abi
      wasi.initialize(abi.memory)
      abi._initialize()
      report.initialMemoryBytes = abi.memory.buffer.byteLength
      const remember = (ptr: number, length: number) => {
        expect(ptr).toBeGreaterThan(0)
        expect(length).toBeGreaterThan(0)
        expect(ptr + length).toBeLessThanOrEqual(abi!.memory.buffer.byteLength)
        for (const [other, size] of ledger) expect(ptr + length <= other || ptr >= other + size).toBe(true)
        ledger.set(ptr, length)
        report.allocations++
        report.liveAllocations = ledger.size
        report.peakLiveBytes = Math.max(report.peakLiveBytes, [...ledger.values()].reduce((a, b) => a + b, 0))
      }
      const release = (ptr: number, length: number) => {
        if (ptr === 0 && length === 0) return
        expect(ledger.get(ptr)).toBe(length)
        abi!.flows_jj_free(ptr, length)
        ledger.delete(ptr)
        report.frees++
        report.liveAllocations = ledger.size
      }
      const exchange = (
        bytes: Uint8Array,
        usedLength = bytes.length,
        grow = false,
        capacity = bytes.length
      ): Record<string, any> => {
        expect(usedLength).toBeGreaterThanOrEqual(0)
        expect(usedLength).toBeLessThanOrEqual(bytes.length)
        expect(capacity).toBeGreaterThanOrEqual(bytes.length)
        const ptr = abi!.flows_jj_alloc(capacity)
        let responsePtr = 0
        let responseLength = 0
        if (capacity === 0) expect(ptr).toBe(0)
        else remember(ptr, capacity)
        try {
          // Only this prefix is initialized; the unused capacity must never
          // become part of the request, even when the JSON prefix is truncated.
          new Uint8Array(abi!.memory.buffer, ptr, bytes.length).set(bytes)
          if (grow) {
            const previousBytes = abi!.memory.buffer.byteLength
            abi!.memory.grow(2)
            expect(abi!.memory.buffer.byteLength).toBe(previousBytes + 2 * 65_536)
            expect(new Uint8Array(abi!.memory.buffer, ptr, bytes.length)).toEqual(bytes)
          }
          const packed = BigInt.asUintN(64, abi!.flows_jj_call(ptr, usedLength))
          expect(packed).not.toBe(0n)
          responsePtr = Number(packed >> 32n)
          responseLength = Number(packed & 0xffff_ffffn)
          remember(responsePtr, responseLength)
          const response = decoder.decode(new Uint8Array(abi!.memory.buffer, responsePtr, responseLength))
          const decoded = JSON.parse(response)
          expect(Object.keys(decoded)).toHaveLength(1)
          expect(JSON.stringify(decoded)).toBe(response)
          report.exchanges++
          return decoded
        } finally {
          if (responsePtr !== 0) release(responsePtr, responseLength)
          if (ptr !== 0) release(ptr, capacity)
          report.currentMemoryBytes = abi!.memory.buffer.byteLength
          report.peakMemoryBytes = Math.max(report.peakMemoryBytes, report.currentMemoryBytes)
          report.openHostFiles = files.size
          expect(ledger.size).toBe(0)
          expect(files.size).toBe(0)
          expect(report.currentMemoryBytes).toBeLessThanOrEqual(report.initialMemoryBytes + 16 * 1024 * 1024)
        }
      }
      const call = (value: unknown) => exchange(encoder.encode(JSON.stringify(value)))
      const healthy = () => {
        const response = call({ op: "diff", root, from: "@", to: "@" })
        expect(response).toEqual({ ok: { diff: "" } })
        report.healthChecks++
        return response
      }
      expect(abi.flows_jj_alloc(0)).toBe(0)
      abi.flows_jj_free(0, 0)
      malformed(exchange(new Uint8Array()))
      expect(call({ op: "init", root })).toEqual({ ok: {} })
      healthy()
      // Layout::array rejects these u32 sizes above wasm32's isize::MAX
      // before allocation. No invalid pointer or mismatched free is involved.
      for (const size of [0x8000_0000, 0xffff_ffff]) {
        const previousBytes = abi.memory.buffer.byteLength
        expect(abi.flows_jj_alloc(size)).toBe(0)
        expect(abi.memory.buffer.byteLength).toBe(previousBytes)
        report.rejectedAllocations.push(size)
        healthy()
      }
      const previousBytes = abi.memory.buffer.byteLength
      expect(() => abi!.memory.grow(65_536)).toThrow(RangeError)
      expect(abi.memory.buffer.byteLength).toBe(previousBytes)
      report.growthFailures++
      healthy()
      const valid = encoder.encode(JSON.stringify({ op: "init", root }))
      const storage = new Uint8Array(valid.length + 1)
      storage.set(valid)
      for (const length of [valid.length - 1, valid.length, valid.length + 1]) {
        const result = exchange(storage, length, length === valid.length)
        report.boundaryLengths.push(length)
        if (length === valid.length) expect(result).toEqual({ ok: {} })
        else malformed(result)
        healthy()
      }
      const unicode = encoder.encode(JSON.stringify({ op: "snapshot", root, message: "文件🚀" }))
      for (let length = 0; length < unicode.length; length++) {
        malformed(exchange(unicode.subarray(0, length), length, false, unicode.length + 4096))
        report.truncatedLengths.push(length)
        healthy()
      }
      // Exercise a large allocated buffer without invalid u32 lengths or frees.
      const large = new Uint8Array(1024 * 1024 + 1)
      large[0] = 0xff
      malformed(exchange(large))
      healthy()
      for (const [index, bytes] of inputs.entries()) {
        report.pendingInputHex = Buffer.from(bytes).toString("hex")
        const response = exchange(bytes)
        malformed(response)
        report.requests.push({ index, inputHex: report.pendingInputHex, response })
        report.executedCases++
        healthy()
      }
      state = seed
      for (let index = 0; index < steps; index++) {
        const before = `seed ${seed} step ${index} value ${next()}\n`
        fs.writeFileSync(join(host, "repo", "generated.txt"), before)
        const first = call({ op: "snapshot", root, message: `generated ${index}` })
        expect(Object.keys(first)).toEqual(["ok"])
        expect(Object.keys(first.ok)).toEqual(["commitId", "changeId", "operationId"])
        expect(first.ok.commitId).toMatch(/^[0-9a-f]{128}$/)
        expect(first.ok.changeId).toMatch(/^[k-z]{12}$/)
        fs.writeFileSync(join(host, "repo", "generated.txt"), `${before}changed\n`)
        const second = call({ op: "snapshot", root })
        expect(Object.keys(second)).toEqual(["ok"])
        expect(Object.keys(second.ok)).toEqual(["commitId", "changeId", "operationId"])
        expect(second.ok.commitId).toMatch(/^[0-9a-f]{128}$/)
        expect(second.ok.changeId).toMatch(/^[k-z]{12}$/)
        expect(second.ok.changeId).toBe(first.ok.changeId)
        expect(first.ok.operationId).toMatch(/^[0-9a-f]{128}$/)
        expect(second.ok.operationId).not.toBe(first.ok.operationId)
        const diff = call({ op: "diff", root, from: first.ok.commitId, to: second.ok.commitId })
        expect(diff).toEqual({ ok: { diff: expectedDiff(before) } })
        const rejected = call({ op: "restore", root, changeId: "kkkkkkkkkkkk" })
        expect(rejected).toEqual({
          err: {
            code: "invalid_ref",
            command: "jj restore --from kkkkkkkkkkkk",
            message: "revision \"kkkkkkkkkkkk\" doesn't exist"
          }
        })
        const restore = call({ op: "restore", root, changeId: first.ok.commitId })
        expect(restore).toEqual({ ok: {} })
        const restoredText = fs.readFileSync(join(host, "repo", "generated.txt"), "utf8")
        expect(restoredText).toBe(before)
        const health = healthy()
        const revisits = []
        for (let turn = 0; turn < 3; turn++) {
          const target = ((seed + index) >>> turn) & 1
          const changeId = target === 0 ? first.ok.commitId : second.ok.commitId
          const response = call({ op: "restore", root, changeId })
          expect(response).toEqual({ ok: {} })
          const text = fs.readFileSync(join(host, "repo", "generated.txt"), "utf8")
          expect(text).toBe(target === 0 ? before : `${before}changed\n`)
          revisits.push({ target, response, restoredText: text, health: healthy() })
        }
        report.operations.push({
          index,
          first,
          second,
          diff,
          failure: rejected,
          restore,
          health,
          restoredText,
          revisits
        })
        report.executedSteps++
      }
      expect(report.allocations).toBe(report.frees)
      report.status = "passed"
    } catch (cause) {
      failed = true
      failure = cause
      report.status = "failed"
      report.failure = String(cause)
    } finally {
      report.liveAllocations = ledger.size
      report.openHostFiles = files.size
      // Every cleanup runs even if an earlier cleanup or evidence write fails;
      // preserve the operation failure as the primary diagnostic.
      const attempt = (cleanup: () => void) => {
        try {
          cleanup()
        } catch (cause) {
          if (!failed) {
            failed = true
            failure = cause
            report.status = "failed"
            report.failure = String(cause)
          }
        }
      }
      for (const [ptr, length] of ledger) attempt(() => abi?.flows_jj_free(ptr, length))
      for (const fd of files) attempt(() => fs.closeSync(fd))
      const cleanupHost = host
      if (cleanupHost !== undefined) attempt(() => fs.rmSync(cleanupHost, { recursive: true, force: true }))
      attempt(() => {
        if (process.env.SMITHERS_ABI_ARTIFACT_DIR !== undefined) {
          fs.mkdirSync(process.env.SMITHERS_ABI_ARTIFACT_DIR, { recursive: true })
          fs.writeFileSync(join(process.env.SMITHERS_ABI_ARTIFACT_DIR, "wasm.json"), JSON.stringify(report, null, 2))
        }
      })
    }
    if (failed) throw failure
  }
)
