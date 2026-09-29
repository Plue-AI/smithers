/**
 * `renderDiagnostic` redacts the value after a credential name in a message,
 * whether the value is bare, quoted, escaped, or cut off by the text bound.
 */
import { expect, it } from "@effect/vitest"
import { inspect } from "node:util"
import { renderDiagnostic } from "../src/internal/Diagnostic.ts"

it("redacts a bare value that starts with a backslash", () => {
  expect(renderDiagnostic("token=\\x41secret rest")).toBe("token=[REDACTED] rest")
  expect(renderDiagnostic("password=C:\\key\\file, next")).toBe("password=[REDACTED], next")
})

it("ends a bare value at an escaped closing quote", () => {
  expect(renderDiagnostic("{\\\"token\\\":abc\\\"}")).toBe("{\\\"token\\\":[REDACTED]\\\"}")
})

it("redacts through the end of the text when a quoted value never closes", () => {
  expect(renderDiagnostic("password=\"hunter2 unterminated")).toBe("password=\"[REDACTED]")
  expect(renderDiagnostic("{\\\"secret\\\":\\\"cut off")).toBe("{\\\"secret\\\":\\\"[REDACTED]")
})

it("keeps the text after a quoted value that closes", () => {
  expect(renderDiagnostic("token=\"ok\" tail")).toBe("token=\"[REDACTED]\" tail")
})

it("closes a quoted value that ends in an escaped backslash, then redacts the next one", () => {
  expect(renderDiagnostic(String.raw`token="abc\\" password="hunter2"`))
    .toBe(`token="[REDACTED]" password="[REDACTED]"`)
  expect(renderDiagnostic(inspect({ token: "abc\\", password: "hunter2" })))
    .toBe("{ token: '[REDACTED]', password: '[REDACTED]' }")
})

it("redacts a quoted value at every JSON string-escape depth and keeps the fields after it", () => {
  const once = JSON.stringify({ token: "hunter2", next: "kept" })
  const twice = JSON.stringify(once)
  const thrice = JSON.stringify(twice)
  expect(renderDiagnostic(String.raw`{\\\"token\\\":\\\"hunter2\\\"}`))
    .toBe(String.raw`{\\\"token\\\":\\\"[REDACTED]\\\"}`)
  for (const text of [once, twice, thrice]) {
    const rendered = renderDiagnostic(text)
    expect(rendered).not.toContain("hunter2")
    expect(rendered).toBe(text.replace("hunter2", "[REDACTED]"))
  }
})

it("redacts a header value to the end of its line, quotes included", () => {
  expect(renderDiagnostic(
    "Authorization: Digest username=\"admin\", response=\"6629fae49393a05397450978507c4ef1\"\nnext line"
  )).toBe("Authorization: [REDACTED]\nnext line")
  expect(renderDiagnostic("Cookie: sid=\"abcSECRET\"; theme=dark")).toBe("Cookie: [REDACTED]")
  expect(renderDiagnostic("{\"authorization\":\"Basic abc\",\"next\":\"kept\"}"))
    .toBe("{\"authorization\":\"[REDACTED]\",\"next\":\"kept\"}")
})

it("matches compound and plural credential names but leaves token counts readable", () => {
  expect(renderDiagnostic("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG")).toBe("aws_secret_access_key=[REDACTED]")
  expect(renderDiagnostic("{\"credentials\":\"abcSECRET\"}")).toBe("{\"credentials\":\"[REDACTED]\"}")
  expect(renderDiagnostic("secretKey=abc")).toBe("secretKey=[REDACTED]")
  expect(renderDiagnostic("tokens: 4096")).toBe("tokens: 4096")
})

it("redacts two adjacent credentials independently", () => {
  expect(renderDiagnostic("password=hunter2,token=abc")).toBe("password=[REDACTED],token=[REDACTED]")
  expect(renderDiagnostic("{\"token\":\"a\",\"secret\":\"b\"}")).toBe(
    "{\"token\":\"[REDACTED]\",\"secret\":\"[REDACTED]\"}"
  )
})

it("redacts a container value to its balanced closer and keeps the fields after it", () => {
  expect(renderDiagnostic("{\"password\":{\"value\":\"hunter2\"},\"status\":401}"))
    .toBe("{\"password\":[REDACTED],\"status\":401}")
  expect(renderDiagnostic("{\"token\":{\"note\":\"a } in a string\",\"deep\":[{\"v\":\"hunter2\"}]},\"status\":401}"))
    .toBe("{\"token\":[REDACTED],\"status\":401}")
  expect(renderDiagnostic(JSON.stringify(JSON.stringify({ password: { value: "hun}ter2" }, status: 401 }))))
    .toBe(String.raw`"{\"password\":[REDACTED],\"status\":401}"`)
})

it("redacts a value after a `=>` separator", () => {
  expect(renderDiagnostic("{\"token\"=>\"abc\"}")).toBe("{\"token\"=>\"[REDACTED]\"}")
  expect(renderDiagnostic(inspect(new Map([["token", "abc"]])))).toBe("Map(1) { 'token' => '[REDACTED]' }")
})

it("redacts a constructor-wrapped value", () => {
  expect(renderDiagnostic("password: Some(\"hunter2\") status: 401")).toBe("password: [REDACTED] status: 401")
})

it("redacts a pretty-printed header list", () => {
  expect(renderDiagnostic(JSON.stringify({ "set-cookie": ["sid=abcSECRET; Path=/"], status: 401 }, null, 2)))
    .toBe("{\n  \"set-cookie\": [REDACTED],\n  \"status\": 401\n}")
})

it("redacts an unbalanced container through the end of the text", () => {
  expect(renderDiagnostic("password: [\"hunter2\", ")).toBe("password: [REDACTED]")
})

it("redacts a bare value through a container inside it", () => {
  expect(renderDiagnostic("password={bcrypt}$2a$10$abcdef next")).toBe("password=[REDACTED] next")
  expect(renderDiagnostic("userPassword: {SSHA}W6ph5Mm5Pz8GgiULbPgzG37mj9g=")).toBe("userPassword: [REDACTED]")
  expect(renderDiagnostic("password=Tr0ub(4dor)&3xyz next")).toBe("password=[REDACTED] next")
  expect(renderDiagnostic("Cookie: prefs[theme]=dark; PHPSESSID=abc123SECRET")).toBe("Cookie: [REDACTED]")
})

it("redacts an inspected value whose constructor is separated from its contents", () => {
  class Foo {
    readonly value = "hunter2"
  }
  expect(renderDiagnostic(inspect({ token: new Foo(), status: 401 }))).toBe("{ token: [REDACTED], status: 401 }")
  expect(renderDiagnostic(inspect({ password: new Map([["a", "hunter2"]]) }))).toBe("{ password: [REDACTED] }")
  expect(renderDiagnostic(inspect({ token: Object.assign(Object.create(null), { v: "hunter2" }) })))
    .toBe("{ token: [REDACTED] }")
  expect(renderDiagnostic("password: new Password(\"hunter2\")")).toBe("password: [REDACTED]")
})

it("ends a bare value at a closer that belongs to the enclosing container", () => {
  expect(renderDiagnostic("{token:abc}, next")).toBe("{token:[REDACTED]}, next")
  expect(renderDiagnostic("password=abc)def next")).toBe("password=[REDACTED] next")
  expect(renderDiagnostic("password: abc next")).toBe("password: [REDACTED] next")
  expect(renderDiagnostic("{token:abc}")).toBe("{token:[REDACTED]}")
  expect(renderDiagnostic("password: abc ")).toBe("password: [REDACTED] ")
})

it("ends a header value at the quote that closes the string it was written in", () => {
  expect(renderDiagnostic("{\"message\":\"Authorization: Bearer abc\",\"status\":401}"))
    .toBe("{\"message\":\"Authorization: [REDACTED]\",\"status\":401}")
  expect(
    renderDiagnostic(
      JSON.stringify(JSON.stringify({ message: "Authorization: Digest username=\"admin\"", status: 401 }))
    )
  )
    .toBe(String.raw`"{\"message\":\"Authorization: [REDACTED]\",\"status\":401}"`)
})

it("keeps a closer in the value unless its opener is open before the key", () => {
  expect(renderDiagnostic("password=Tr0ub4dor)]&3xyz next")).toBe("password=[REDACTED] next")
  expect(renderDiagnostic("api_key=ab}}cd")).toBe("api_key=[REDACTED]")
  expect(renderDiagnostic("Cookie: theme=dark); PHPSESSID=abc123SECRET")).toBe("Cookie: [REDACTED]")
  expect(renderDiagnostic("password=hunter2)")).toBe("password=[REDACTED]")
  expect(renderDiagnostic("{token:abc}, next")).toBe("{token:[REDACTED]}, next")
  expect(renderDiagnostic("(a) [{token:abc}] (password=x)")).toBe("(a) [{token:[REDACTED]}] (password=[REDACTED])")
})

it("ends a header value at the close of the string it was written in, whatever precedes the quote", () => {
  expect(renderDiagnostic("{\"message\":\"Authorization: Basic dXNlcjpzM2NyZXQ=\",\"password\":\"hunter2\"}"))
    .toBe("{\"message\":\"Authorization: [REDACTED]\",\"password\":\"[REDACTED]\"}")
  expect(renderDiagnostic("{\"error\":\"Cookie: sid=abc;\",\"token\":\"SECRET\"}"))
    .toBe("{\"error\":\"Cookie: [REDACTED]\",\"token\":\"[REDACTED]\"}")
  expect(renderDiagnostic("{\"a\":\"Cookie: x=\",\"cookie\":\"sid=SECRET\"}"))
    .toBe("{\"a\":\"Cookie: [REDACTED]\",\"cookie\":\"[REDACTED]\"}")
  expect(renderDiagnostic(String.raw`"{\"message\":\"Authorization: Basic abc=\",\"password\":\"hunter2\"}"`))
    .toBe(String.raw`"{\"message\":\"Authorization: [REDACTED]\",\"password\":\"[REDACTED]\"}"`)
  expect(renderDiagnostic("{\"message\":\"can't sign in, Authorization: Basic abc=\",\"password\":\"hunter2\"}"))
    .toBe("{\"message\":\"can't sign in, Authorization: [REDACTED]\",\"password\":\"[REDACTED]\"}")
})

it("keeps a closer in the value when the closers after it do not balance the enclosing brackets", () => {
  expect(renderDiagnostic("(password=Tr0ub4dor)]&3xyz)")).toBe("(password=[REDACTED])")
})

it("keeps redacting a header value that starts with a bracketed prefix", () => {
  expect(renderDiagnostic("Proxy-Authorization = {x}SECRET, token=abc")).toBe(
    "Proxy-Authorization = [REDACTED]"
  )
  expect(renderDiagnostic("{\"message\":\"Set-Cookie:{x}SECRET\",\"status\":401}"))
    .toBe("{\"message\":\"Set-Cookie:[REDACTED]\",\"status\":401}")
  expect(renderDiagnostic("Cookie: [sid=SECRET]")).toBe("Cookie: [REDACTED]")
})

it("ends a bare value at the next credential name instead of swallowing it", () => {
  expect(renderDiagnostic("credentials=abc]&userPassword = SECRET")).toBe("credentials=[REDACTED]Password = [REDACTED]")
  expect(renderDiagnostic("apiKey=>abc}\\ncredential: SECRET)")).toBe("apiKey=>[REDACTED]credential: [REDACTED]")
  expect(renderDiagnostic("token: Foo { v: 'a' }&userPassword: 'SECRET'"))
    .toBe("token: [REDACTED]Password: '[REDACTED]'")
})

it("redacts a name inside a container the value consumed together with the value", () => {
  expect(renderDiagnostic(inspect({ password: { token: "a", value: "hunter2" } }))).toBe("{ password: [REDACTED] }")
  expect(renderDiagnostic("password={token:a}hunter2&secret=SECRET")).toBe("password=[REDACTED]secret=[REDACTED]")
})

it("closes a double-quoted value inside an inspected single-quoted string at doubled backslashes", () => {
  expect(renderDiagnostic(inspect({ message: "api_key: \"a\\\"SECRET\"", status: 401 })))
    .toBe("{ message: 'api_key: \"[REDACTED]\"', status: 401 }")
})

it("keeps a name=value pair inside a header value part of the header", () => {
  expect(renderDiagnostic("Cookie: csrftoken=abc; sessionid=SECRET")).toBe("Cookie: [REDACTED]")
  expect(renderDiagnostic("Cookie: XSRF-TOKEN=abc; laravel_session=SECRET")).toBe("Cookie: [REDACTED]")
  expect(renderDiagnostic(
    "Authorization: AWS4-HMAC-SHA256 Credential=AKID/20260929/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=5d67SECRET"
  )).toBe("Authorization: [REDACTED]")
  expect(renderDiagnostic("{\"message\":\"Cookie: access_token=abc; sid=SECRET\"}"))
    .toBe("{\"message\":\"Cookie: [REDACTED]\"}")
  expect(renderDiagnostic("{\"cookie\":[\"sid=a\"] ,\"token\":\"SECRET\"}"))
    .toBe("{\"cookie\":[REDACTED] ,\"token\":\"[REDACTED]\"}")
})

it("closes a quoted value no earlier than doubled backslashes allow when no enclosing string is visible", () => {
  expect(renderDiagnostic(String.raw`${"`"}api_key: "a\\"SECRET"${"`"}`)).toBe("`api_key: \"[REDACTED]\"`")
  expect(renderDiagnostic(String.raw`token="a\\"b" then password=x`)).toBe(
    "token=\"[REDACTED]\" then password=[REDACTED]"
  )
  expect(renderDiagnostic(String.raw`token="abc\\"SECRET password="x"`)).toBe(
    "token=\"[REDACTED]password=\"[REDACTED]\""
  )
})

it("opens a quote right after a credential name inside a header value", () => {
  expect(renderDiagnostic(String.raw`api_key:a\\"x Proxy-Authorization:b\x credential:"SECRET"`))
    .toBe(String.raw`api_key:[REDACTED]\\"x Proxy-Authorization:[REDACTED]`)
})
