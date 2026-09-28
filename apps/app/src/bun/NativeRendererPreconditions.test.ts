import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startNativeRendererServer } from './NativeRendererServer'

test('packaged renderer refuses a missing index before opening its server', () => {
  const dist = mkdtempSync(join(tmpdir(), 'smithers-native-no-index-'))
  try {
    let failure: unknown
    try { startNativeRendererServer(dist, 'http://127.0.0.1:4185') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(`The packaged UI is missing ${join(dist, 'index.html')}.`)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
