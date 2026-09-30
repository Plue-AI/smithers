import { describe, expect, test } from "bun:test"
import { CString, JSCallback, type Pointer } from "bun:ffi"
import { fakeNativeWrapper } from "../../e2e/native/FakeNativeWrapper"
import { retainNativeUrlOpens } from "./NativeUrlOpen"

/* Threadsafe callbacks run as later tasks; wait for them without a fixed sleep. */
const settle = async (received: ReadonlyArray<string>, count: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (received.length < count && Date.now() < deadline) await Bun.sleep(5)
  // One more turn so an unexpected extra delivery would show.
  await Bun.sleep(20)
}

/* The handler Electrobun's SDK installs: a threadsafe callback that reads the string when its task runs. */
const sdkHandler = (received: Array<string>): JSCallback =>
  new JSCallback((url: Pointer) => received.push(new CString(url).toString()), {
    args: ["ptr"],
    returns: "void",
    threadsafe: true
  })

const link = "smithers://open/smithersai/smithers"
const long = `smithers://open/${"o".repeat(900)}/${"r".repeat(900)}`

describe("native smithers:// links survive the wrapper freeing them (#3061)", () => {
  test("the SDK's own handler reads freed memory for a cold-launch link", async () => {
    const wrapper = fakeNativeWrapper()
    const received: Array<string> = []
    wrapper.openUrl(link)
    wrapper.setURLOpenHandler(sdkHandler(received).ptr!)
    await settle(received, 1)
    expect(received).toHaveLength(1)
    expect(received[0]).not.toBe(link)
  })

  test("links buffered before launch arrive intact, in order, and the SDK's later install finds none", async () => {
    const wrapper = fakeNativeWrapper()
    wrapper.openUrl(link)
    wrapper.openUrl(long)
    const received: Array<string> = []
    const urlOpens = retainNativeUrlOpens(wrapper, (url) => received.push(url))
    const sdkReceived: Array<string> = []
    wrapper.setURLOpenHandler(sdkHandler(sdkReceived).ptr!)
    urlOpens.install()
    await settle(received, 2)
    expect(received).toEqual([link, long])
    expect(sdkReceived).toEqual([])
  })

  test("with no buffered link, retaining delivers nothing", async () => {
    const wrapper = fakeNativeWrapper()
    const received: Array<string> = []
    retainNativeUrlOpens(wrapper, (url) => received.push(url))
    await settle(received, 0)
    expect(received).toEqual([])
  })

  test("after install, a link to the running app arrives intact and never reaches the SDK", async () => {
    const wrapper = fakeNativeWrapper()
    const received: Array<string> = []
    const urlOpens = retainNativeUrlOpens(wrapper, (url) => received.push(url))
    const sdkReceived: Array<string> = []
    wrapper.setURLOpenHandler(sdkHandler(sdkReceived).ptr!)
    urlOpens.install()
    wrapper.openUrl("smithers://open/acme/widgets")
    wrapper.openUrl(long)
    await settle(received, 2)
    expect(received).toEqual(["smithers://open/acme/widgets", long])
    expect(sdkReceived).toEqual([])
  })

  test("without install, the SDK's handler takes over again and reads freed memory", async () => {
    const wrapper = fakeNativeWrapper()
    const received: Array<string> = []
    retainNativeUrlOpens(wrapper, (url) => received.push(url))
    const sdkReceived: Array<string> = []
    wrapper.setURLOpenHandler(sdkHandler(sdkReceived).ptr!)
    wrapper.openUrl(link)
    await settle(sdkReceived, 1)
    expect(received).toEqual([])
    expect(sdkReceived).toHaveLength(1)
    expect(sdkReceived[0]).not.toBe(link)
  })
})
