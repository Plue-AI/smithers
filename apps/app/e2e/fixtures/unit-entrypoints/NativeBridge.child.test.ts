import { expect, mock, test } from 'bun:test'
import type { PackagedE2EBridgeOptions } from '../../../src/bun/PackagedE2EBridge'

const calls: string[] = []
const captures: Array<{ x: number; y: number; width: number; height: number }> = []
const encoded: Array<{ width: number; height: number; pixels: Uint8Array }> = []
const scripts: string[] = []
const hidden = process.env.SMITHERS_NATIVE_BRIDGE_SCENARIO === 'hidden'
const windowModes: boolean[] = []
const png = new Uint8Array([137, 80, 78, 71])
const pixels = new Uint8Array(24)
let bridge: PackagedE2EBridgeOptions | undefined
let sdkResponse: unknown = { ok: true, json: 'null' }
let frame: { x: number; y: number; width: number; height: number } | undefined = { x: 4, y: 8, width: 2.4, height: 3.4 }
let captureAvailable = true

const originalExit = process.exit
process.exit = ((code?: number) => { calls.push(`exit:${code ?? 0}`); return undefined as never }) as typeof process.exit

mock.module('electrobun/main', () => ({
  default: { events: { on: () => {} } },
  BrowserView: { defineRPC: () => ({ proxy: {} }) },
  BrowserWindow: class {
    readonly id = 7
    readonly webviewId = 9
    readonly renderer = 'cef'
    readonly url: string
    readonly webview: { rpc?: { requestProxy: { evaluateJavascriptWithResponse: (input: { script: string }) => Promise<unknown> } } }
    constructor(options: { url: string; hidden: boolean }) {
      this.url = options.url
      windowModes.push(options.hidden)
      this.webview = { rpc: { requestProxy: { evaluateJavascriptWithResponse: async ({ script }) => {
        scripts.push(script)
        return sdkResponse
      } } } }
      windowRef = this
    }
    getFrame() { return frame }
    activate() { calls.push('window:activate') }
  },
  BuildConfig: { getSync: () => ({ isPackaged: true, channel: 'stable', defaultRenderer: 'native' }) },
  Screen: { captureRegion: (area: { x: number; y: number; width: number; height: number }) => {
    captures.push(area)
    return captureAvailable ? pixels : null
  } },
  Utils: { openExternal: () => true }
}))

let windowRef: {
  webview: { rpc?: { requestProxy: { evaluateJavascriptWithResponse: (input: { script: string }) => Promise<unknown> } } }
} | undefined

mock.module('../../../src/bun/NativeBackendProcess', () => ({ startNativeBackend: async () => ({
  mode: 'own', origin: 'http://127.0.0.1:4185', failure: new Promise<undefined>(() => {}),
  stop: async () => { calls.push('backend:stop') }
}) }))
mock.module('../../../src/bun/NativeRendererServer', () => ({ startNativeRendererServer: () => ({
  origin: 'http://127.0.0.1:4920',
  stop: () => { calls.push('renderer:stop') },
  setTarget: () => {}
}) }))
mock.module('../../../src/bun/NativeState', () => ({ nativeStateDirectory: () => '/state' }))
mock.module('../../../src/bun/server', () => ({
  defaultDistDir: () => '/web',
  startLocalServer: () => { throw new Error('stub server must not start') }
}))
mock.module('../../../src/bun/PackagedE2EBridge', () => ({
  encodeRgbaPng: (width: number, height: number, value: Uint8Array) => {
    encoded.push({ width, height, pixels: value })
    return png
  },
  startPackagedE2EBridge: (options: PackagedE2EBridgeOptions) => {
    bridge = options
    return { stop: () => { calls.push('bridge:stop') } }
  }
}))

test('native bridge callbacks report state, evaluate responses, capture, and quit', async () => {
  try {
    await import('../../../src/bun/index')
    expect(bridge).toBeDefined()
    const options = bridge!
    expect(windowModes).toEqual([hidden])
    expect(await options.state()).toEqual({
      app: { pid: process.pid, origin: 'http://127.0.0.1:4920', packaged: true, channel: 'stable', defaultRenderer: 'native' },
      window: { id: 7, webviewId: 9, renderer: 'cef', url: 'http://127.0.0.1:4920/', frame: { x: 4, y: 8, width: 2.4, height: 3.4 } }
    })

    sdkResponse = { ok: true, json: '{"answer":42}' }
    expect(await options.evaluate('return { answer: 42 }')).toEqual({ answer: 42 })
    expect(scripts.at(-1)).toContain('return { answer: 42 }')
    sdkResponse = { ok: true, json: 'null' }
    expect(await options.evaluate('return null')).toBeNull()
    sdkResponse = { ok: true, json: 'null', valueUndefined: true }
    expect(await options.evaluate('return undefined')).toBeUndefined()
    sdkResponse = { ok: false, error: 'renderer denied' }
    await expect(options.evaluate('throw denied')).rejects.toThrow('renderer denied')
    sdkResponse = { ok: true, json: '{bad' }
    await expect(options.evaluate('return bad')).rejects.toThrow()
    sdkResponse = { ok: true }
    await expect(options.evaluate('return missing')).rejects.toThrow('Renderer evaluation returned no serialized value.')
    sdkResponse = 'invalid response'
    await expect(options.evaluate('return malformed')).rejects.toThrow('Renderer evaluation failed: invalid response')
    if (windowRef !== undefined) windowRef.webview.rpc = undefined
    await expect(options.evaluate('return 1')).rejects.toThrow('The main WebView is not available.')

    if (hidden) {
      expect(await options.screenshot()).toBeNull()
      expect(captures).toEqual([])
      expect(encoded).toEqual([])
      expect(calls).not.toContain('window:activate')
    } else {
      expect(await options.screenshot()).toBe(png)
      expect(captures).toEqual([{ x: 4, y: 8, width: 2, height: 3 }])
      expect(encoded).toEqual([{ width: 2, height: 3, pixels }])
      captureAvailable = false
      expect(await options.screenshot()).toBeNull()
      frame = undefined
      expect(await options.screenshot()).toBeNull()
      expect(captures).toHaveLength(2)
    }

    await options.quit()
    expect(calls).toContain('bridge:stop')
    expect(calls).toContain('renderer:stop')
    expect(calls).toContain('backend:stop')
    expect(calls).toContain('exit:0')
  } finally {
    process.exit = originalExit
  }
})
