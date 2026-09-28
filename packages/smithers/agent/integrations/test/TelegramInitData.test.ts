import { webcrypto } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  ED25519_PUBLIC_KEY_PROD,
  ED25519_PUBLIC_KEY_TEST,
  parse,
  verifySignature,
  verifyWithBotToken
} from "../src/telegram/InitData.ts"

const BOT_TOKEN = "123456:AA-bot-token"
const BOT_ID = 123456
const NOW = 1_700_000_000_000
const AUTH_DATE = Math.floor(NOW / 1000)

const encoder = new TextEncoder()

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const dataCheckString = (fields: ReadonlyArray<readonly [string, string]>): string =>
  fields.map(([key, value]) => `${key}=${value}`).sort().join("\n")

const query = (fields: ReadonlyArray<readonly [string, string]>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of fields) params.set(key, value)
  return params.toString()
}

const USER = JSON.stringify({ id: 7, username: "will", first_name: "Will" })

/** Signs `initData` the way Telegram does: HMAC under HMAC("WebAppData", token). */
const signWithBotToken = async (fields: ReadonlyArray<readonly [string, string]>): Promise<string> => {
  const webAppDataKey = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const secret = await webcrypto.subtle.sign("HMAC", webAppDataKey, encoder.encode(BOT_TOKEN))
  const secretKey = await webcrypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await webcrypto.subtle.sign("HMAC", secretKey, encoder.encode(dataCheckString(fields)))
  return hex(mac)
}

const baseFields = (authDate = AUTH_DATE): ReadonlyArray<readonly [string, string]> => [
  ["auth_date", String(authDate)],
  ["query_id", "AAE"],
  ["user", USER]
]

const hmacInitData = async (
  fields: ReadonlyArray<readonly [string, string]> = baseFields()
): Promise<string> => query([...fields, ["hash", await signWithBotToken(fields)]])

describe("parse", () => {
  it("reads every field, including JSON blobs with percent-encoded delimiters", async () => {
    const initData = await hmacInitData([
      ...baseFields(),
      ["chat", JSON.stringify({ id: -100, title: "A & B" })],
      ["chat_type", "supergroup"],
      ["chat_instance", "-999"],
      ["start_param", "deep-link"],
      ["receiver", JSON.stringify({ id: 8 })]
    ])
    const parsed = parse(initData)
    expect(parsed.user).toMatchObject({ id: 7, username: "will" })
    expect(parsed.chat).toMatchObject({ id: -100, title: "A & B" })
    expect(parsed.receiver).toMatchObject({ id: 8 })
    expect(parsed.authDate).toBe(AUTH_DATE)
    expect(parsed.queryId).toBe("AAE")
    expect(parsed.chatType).toBe("supergroup")
    expect(parsed.chatInstance).toBe("-999")
    expect(parsed.startParam).toBe("deep-link")
    expect(parsed.params["hash"]).toBe(parsed.hash)
  })

  it("returns nulls for an empty or malformed string", () => {
    const parsed = parse("")
    expect(parsed).toMatchObject({ raw: "", hash: null, signature: null, authDate: null, user: null })
    expect(parse(7 as unknown as string).raw).toBe("")
    expect(parse("auth_date=soon&user=not-json").authDate).toBeNull()
    expect(parse("user=not-json").user).toBeNull()
    expect(parse("user=\"scalar\"").user).toBeNull()
    expect(parse("user=").user).toBeNull()
  })
})

describe("verifyWithBotToken", () => {
  it("accepts initData Telegram signed", async () => {
    const initData = await hmacInitData()
    const verified = await verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })
    expect(verified.user).toMatchObject({ id: 7 })
    expect(verified.raw).toBe(initData)
  })

  it("reports an unsupported runtime when Web Crypto is unavailable", async () => {
    const initData = await hmacInitData()
    vi.stubGlobal("crypto", undefined)
    try {
      await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).rejects.toMatchObject({
        code: "UNSUPPORTED"
      })
      await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW }))
        .rejects.toThrow("Web Crypto (crypto.subtle) is not available in this runtime.")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // The `signature` field stays inside the HMAC data-check string; only `hash`
  // is removed. Dropping both would reject every modern client.
  it("keeps the signature field inside the data-check string", async () => {
    const fields = [...baseFields(), ["signature", "abc"] as const]
    const initData = await hmacInitData(fields)
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).resolves.toBeDefined()
  })

  it("rejects a tampered field", async () => {
    const initData = await hmacInitData()
    const tampered = initData.replace("id%3A7", "id%3A8").replace("%227%22", "%228%22")
    const swapped = `${tampered}&extra=1`
    await expect(verifyWithBotToken(swapped, BOT_TOKEN, { nowMs: NOW })).rejects.toThrow(/does not match/)
  })

  it("rejects a hash signed with a different bot token", async () => {
    const initData = await hmacInitData()
    await expect(verifyWithBotToken(initData, "999:other", { nowMs: NOW })).rejects.toThrow(/does not match/)
  })

  it("rejects a hash whose length cannot match the computed digest", async () => {
    const params = new URLSearchParams(await hmacInitData())
    params.set("hash", "00")
    await expect(verifyWithBotToken(params.toString(), BOT_TOKEN, { nowMs: NOW })).rejects.toThrow(/does not match/)
  })

  it("rejects empty initData, a missing hash, and a missing bot token", async () => {
    await expect(verifyWithBotToken("", BOT_TOKEN)).rejects.toThrow(/empty/)
    await expect(verifyWithBotToken(query(baseFields()), BOT_TOKEN)).rejects.toThrow(/missing the hash/)
    await expect(verifyWithBotToken(await hmacInitData(), "")).rejects.toThrow(/requires a bot token/)
  })

  it("rejects stale initData and accepts it when the check is disabled", async () => {
    const initData = await hmacInitData(baseFields(AUTH_DATE - 7200))
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).rejects.toThrow(/expired/)
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW, maxAgeSeconds: 0 })).resolves.toBeDefined()
  })

  it("rejects initData with no auth_date at all", async () => {
    const fields = [["query_id", "AAE"]] as const
    const initData = await hmacInitData(fields)
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).rejects.toThrow(/missing auth_date/)
  })
})

describe("verifySignature", () => {
  const ed25519Fields = (authDate = AUTH_DATE): ReadonlyArray<readonly [string, string]> => [
    ["auth_date", String(authDate)],
    ["user", USER]
  ]

  const signEd25519 = async (
    fields: ReadonlyArray<readonly [string, string]>
  ): Promise<{ readonly initData: string; readonly publicKeyHex: string }> => {
    const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify"
    ]) as unknown as CryptoKeyPair
    const publicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey))
    const message = `${BOT_ID}:WebAppData\n${dataCheckString(fields)}`
    const signature = new Uint8Array(
      await webcrypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(message))
    )
    return {
      initData: query([...fields, ["signature", base64Url(signature)], ["hash", "unused"]]),
      publicKeyHex: [...publicKey].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    }
  }

  it("accepts a signature made with the matching key", async () => {
    const { initData, publicKeyHex } = await signEd25519(ed25519Fields())
    const verified = await verifySignature(initData, BOT_ID, { publicKeyHex, nowMs: NOW })
    expect(verified.user).toMatchObject({ id: 7 })
  })

  it("reports an unsupported runtime when Ed25519 key import is unavailable", async () => {
    const { initData, publicKeyHex } = await signEd25519(ed25519Fields())
    vi.stubGlobal("crypto", {
      subtle: { importKey: () => Promise.reject(new Error("Ed25519 unavailable")) }
    })
    try {
      await expect(verifySignature(initData, BOT_ID, { publicKeyHex, nowMs: NOW })).rejects.toMatchObject({
        code: "UNSUPPORTED"
      })
      await expect(verifySignature(initData, BOT_ID, { publicKeyHex, nowMs: NOW }))
        .rejects.toThrow("Ed25519 verification is not supported in this runtime.")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("rejects a signature from a different key, which is what Telegram's own key is here", async () => {
    const { initData } = await signEd25519(ed25519Fields())
    await expect(verifySignature(initData, BOT_ID, { nowMs: NOW })).rejects.toThrow(/does not match/)
    await expect(verifySignature(initData, BOT_ID, { publicKeyHex: ED25519_PUBLIC_KEY_TEST, nowMs: NOW }))
      .rejects.toThrow(/does not match/)
  })

  it("rejects a signature over a different bot id", async () => {
    const { initData, publicKeyHex } = await signEd25519(ed25519Fields())
    await expect(verifySignature(initData, 999, { publicKeyHex, nowMs: NOW })).rejects.toThrow(/does not match/)
  })

  it("rejects empty initData, a missing signature, a missing bot id, and staleness", async () => {
    const { initData, publicKeyHex } = await signEd25519(ed25519Fields())
    await expect(verifySignature("", BOT_ID)).rejects.toThrow(/empty/)
    await expect(verifySignature(query(ed25519Fields()), BOT_ID)).rejects.toThrow(/missing the signature/)
    await expect(verifySignature(initData, "")).rejects.toThrow(/requires a numeric bot id/)
    const stale = await signEd25519(ed25519Fields(AUTH_DATE - 7200))
    await expect(verifySignature(stale.initData, BOT_ID, { publicKeyHex: stale.publicKeyHex, nowMs: NOW }))
      .rejects.toThrow(/expired/)
    expect(publicKeyHex).toHaveLength(64)
  })

  // The signature is attacker-controlled, so a malformed value must reject as
  // invalid init data rather than escape as a platform exception.
  it("rejects a signature that is not valid base64url", async () => {
    const initData = query([...ed25519Fields(), ["signature", "!!!not-base64!!!"]])
    await expect(verifySignature(initData, BOT_ID, { nowMs: NOW })).rejects.toThrow(/not valid base64url/)
  })

  // A typo pointing at the test-datacenter key used to be reported as
  // "Ed25519 is not supported in this runtime", which sends an operator
  // looking at Node versions instead of at their own argument.
  it("names a malformed public key as caller input, not an unsupported runtime", async () => {
    const { initData } = await signEd25519(ed25519Fields())
    for (const publicKeyHex of ["zz", "abc", `${ED25519_PUBLIC_KEY_TEST}00`]) {
      await expect(verifySignature(initData, BOT_ID, { publicKeyHex, nowMs: NOW }))
        .rejects.toThrow(/publicKeyHex must be 64 hexadecimal characters/)
    }
  })

  it("ships Telegram's production and test keys", () => {
    expect(ED25519_PUBLIC_KEY_PROD).toHaveLength(64)
    expect(ED25519_PUBLIC_KEY_TEST).toHaveLength(64)
  })
})

describe("the freshness window is bounded at both ends", () => {
  // Only bounding the old end let a correctly signed far-future `auth_date`
  // stay fresh for as long as it was dated ahead.
  it("refuses a payload dated beyond the accepted future skew", async () => {
    const future = Math.floor(NOW / 1000) + 3600
    const initData = await hmacInitData(baseFields(future))
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).rejects.toThrow(/expired/)
  })

  it("accepts a small clock difference", async () => {
    const nearFuture = Math.floor(NOW / 1000) + 60
    const initData = await hmacInitData(baseFields(nearFuture))
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: NOW })).resolves.toBeDefined()
  })

  // `nowMs` exists for the tests. A caller that passes none gets the wall
  // clock, which is the spelling every real Mini App verification uses.
  it("reads the wall clock when the caller supplies no nowMs", async () => {
    const fresh = await hmacInitData(baseFields(Math.floor(Date.now() / 1000)))
    await expect(verifyWithBotToken(fresh, BOT_TOKEN)).resolves.toBeDefined()
    const ancient = await hmacInitData(baseFields(Math.floor(Date.now() / 1000) - 999_999))
    await expect(verifyWithBotToken(ancient, BOT_TOKEN)).rejects.toThrow(/expired/)
  })

  // A zero or negative policy silently disabled the check rather than
  // reporting the configuration mistake it is.
  it("refuses a freshness policy that is not a usable window", async () => {
    const initData = await hmacInitData()
    for (const maxAgeSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_401]) {
      await expect(verifyWithBotToken(initData, BOT_TOKEN, { maxAgeSeconds, nowMs: NOW }))
        .rejects.toThrow(/maxAgeSeconds must be an integer/)
    }
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { nowMs: Number.NaN }))
      .rejects.toThrow(/nowMs must be a finite number/)
  })

  it("still lets an explicit zero disable the age check", async () => {
    const ancient = Math.floor(NOW / 1000) - 999_999
    const initData = await hmacInitData(baseFields(ancient))
    await expect(verifyWithBotToken(initData, BOT_TOKEN, { maxAgeSeconds: 0, nowMs: NOW })).resolves.toBeDefined()
  })
})
