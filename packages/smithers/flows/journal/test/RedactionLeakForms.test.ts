/**
 * The spellings `util.inspect`, escaped JSON and command lines give a
 * credential, each once past the default rules. Every case pins that the
 * secret's bytes are gone and the placeholder stands in their place. All
 * secrets are synthetic.
 */
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import * as Redaction from "../src/Redaction.ts"

const secret = "ZqSynthetic7Secret4Value9"

describe("Git OAuth credential usernames", () => {
  it.each(["http", "https", "HTTPS"])("redacts the username before password rewriting for %s", (scheme) => {
    const input = `${scheme}://${secret}:x-oauth-basic@host.invalid/private.git?view=all`
    const expected = `${scheme}://[REDACTED]@host.invalid/private.git?view=all`
    for (const redact of [Redaction.redact, Redaction.redactDiagnostic]) {
      const output = redact(input)
      expect(output).toBe(expected)
      expect(output).not.toContain(secret)
      expect(redact(output)).toBe(output)
    }
  })

  it("preserves ordinary PostgreSQL usernames and readable URL suffixes", () => {
    const input = "postgres://ordinary:hunter2@db.invalid/app?view=all"
    for (const redact of [Redaction.redact, Redaction.redactDiagnostic]) {
      expect(redact(input)).toBe("postgres://ordinary:[REDACTED]@db.invalid/app?view=all")
    }
  })
})

const pem = [
  "-----BEGIN RSA PRIVATE KEY-----",
  ...Array.from({ length: 12 }, (_, line) => `${secret}${line}`.padEnd(64, "A")),
  "-----END RSA PRIVATE KEY-----"
].join("\n")

const hex = [...Buffer.from(secret)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")

const expectRedacted = (value: unknown, ...leaks: ReadonlyArray<string>) => {
  const rendered = JSON.stringify(value)
  for (const leak of [secret, ...leaks]) expect(rendered).not.toContain(leak)
  expect(rendered).toContain(Redaction.placeholder)
}

describe("the default rules", () => {
  it.each([
    ["an inspected multi-line concatenation", inspect({ privateKey: `${secret}\n`.repeat(8) })],
    ["a PEM block with no footer", pem.split("-----END")[0]!],
    ["an inspected <Buffer ..>", inspect({ token: Buffer.from(secret) })],
    [
      "a value after <ref *1>",
      (() => {
        const holder: Record<string, unknown> = { value: secret }
        holder["self"] = holder
        return inspect({ apiKey: holder })
      })()
    ],
    ["a value after [Object: null prototype]", inspect({ apiKey: Object.assign(Object.create(null), { v: secret }) })],
    [
      "a PGP private key block",
      `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${secret}\n-----END PGP PRIVATE KEY BLOCK-----`
    ],
    ["a backtick-quoted value", inspect({ password: `it's "a ${secret}"` })],
    ["an escaped JSON value", JSON.stringify(JSON.stringify({ password: `a ${secret} b` }))],
    ["a nested container", JSON.stringify({ apiKey: { a: { b: { c: { d: { e: secret } } } } } }, null, 2)],
    ["a credential flag", `deploy --api-token ${secret} --verbose`],
    ["a credential flag in a JSON argv", JSON.stringify(["deploy", "--password", secret])],
    [
      "an inspected multi-line concatenation written into a JSON string",
      JSON.stringify(inspect({ privateKey: `${secret}\n`.repeat(8) }))
    ]
  ])("redacts %s", (_name, text) => {
    // The input carries the secret, or for a buffer its bytes.
    expect(text.includes(secret.slice(0, 12)) || text.includes(hex)).toBe(true)
    expectRedacted(Redaction.redact(text), hex)
  })

  it.each([
    ["a quoted closer inside a container", inspect({ token: { value: `} ${secret}` } })],
    ["a quoted ] inside an array", inspect({ token: [`] ${secret}`] })],
    ["an unterminated value ending in a backslash", `password: '${secret}\\`],
    [
      "a key block ahead of the secret in one string",
      inspect({ privateKey: `${pem.split("\n").slice(0, 1).join("")}\nQUJD\n-----END RSA PRIVATE KEY-----\n${secret}` })
    ],
    ["a value escaped three times", JSON.stringify(JSON.stringify(JSON.stringify({ password: secret })))],
    ["a placeholder followed by the secret", `password=[REDACTED]${secret}`],
    ["a value that looks like a name: pair", `probe-0:api_key=${secret}-secret:end`],
    [
      "an escaped quote inside an inspected JSON body",
      inspect({ body: JSON.stringify({ password: `Tr0ub"${secret}` }) })
    ]
  ])("redacts %s", (_name, text) => {
    expectRedacted(Redaction.redact(text))
  })

  it("reads a balanced container that ends the text whole", () => {
    expect(String(Redaction.redact(`credentials: {\n pass: "${secret}"\n}`))).toBe(
      `credentials: ${Redaction.placeholder}`
    )
  })

  it.each([
    `{"sortKey":"alpha","idempotencyKey":"job-42"}`,
    "--max-tokens 4096 --idempotencyKey job-42"
  ])("keeps non-credential names in %s", (text) => {
    expect(Redaction.redact(text)).toBe(text)
  })

  it("keeps ordinary argv data around credential flags", () => {
    expect(Redaction.redact(["--max-tokens", "4096", "--idempotencyKey", "job-42", "--token=x", "--verbose"]))
      .toEqual(["--max-tokens", "4096", "--idempotencyKey", "job-42", `--token=${Redaction.placeholder}`, "--verbose"])
  })

  it("redacts the element after a credential flag in an argv array", () => {
    expect(Redaction.redact(["deploy", "--password", secret, "--verbose"])).toEqual([
      "deploy",
      "--password",
      Redaction.placeholder,
      "--verbose"
    ])
  })

  it.each(["max_tokens: 4096 > 4000", "input_tokens=12", `{"max_tokens":4096}`])(
    "keeps the token count in %s",
    (text) => {
      expect(Redaction.redactDiagnostic(text)).toBe(text)
    }
  )

  it("still redacts a numeric singular token", () => {
    expect(Redaction.redact("token: 4096")).toBe(`token: ${Redaction.placeholder}`)
  })

  it.each([
    ["a container whose first line ends in a member's comma", `credentials: { pass: "first",\n other: "${secret}"\n}`],
    ["a closed container followed by an unclosed opener", `password: [\n  '${secret}'\n]('x')`]
  ])("redacts %s whole", (_name, text) => {
    expectRedacted(Redaction.redact(text))
  })

  it("keeps plural key names that are not a credential's, and redacts one that is", () => {
    const redacted = String(Redaction.redact(`{"keys":["id","name"],"sortKeys":true,"apiKeys":["${secret}"]}`))
    expect(redacted).toContain(`"keys":["id","name"],"sortKeys":true`)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain(Redaction.placeholder)
  })

  it("leaves a -p value alone in a durable row", () => {
    expect(Redaction.redact("mkdir -p build/out")).toBe("mkdir -p build/out")
    expect(Redaction.redact(["ssh", "-p", "2222", "host"])).toEqual(["ssh", "-p", "2222", "host"])
  })

  it("keeps the host and path of a URL whose user names a credential", () => {
    // A git remote's user is `x-access-token`, which reads as a credential
    // name; its value is still only the password before `@`.
    const remote = (password: string) => `'https://x-access-token:${password}@github.com/acme/private.git/': 403`
    expect(Redaction.redact(remote(secret))).toBe(remote(Redaction.placeholder))
    expect(Redaction.redact(`token:${secret}@github.com`)).toBe(`token:${Redaction.placeholder}`)
    const diagnostic = String(Redaction.redactDiagnostic(remote(secret)))
    expect(diagnostic).not.toContain(secret)
    expect(diagnostic).toContain(`${Redaction.placeholder}@github.com/acme/private.git/': 403`)
  })
})

describe("the default rules in a durable row", () => {
  it.each([
    ["a Markdown code span", "Set `GITHUB_TOKEN=` in your env.\nThen run it.", "Then run it."],
    ["a non-credential key name", "sortKey: [[[[[[1]]]]]]\nrest of report", "rest of report"],
    ["an idempotency key", "idempotencyKey: {\n run: 'r1'\n}", "run: 'r1'"],
    ["an empty assignment", "api_key=\nnext line", "next line"],
    ["prose after a one-word value", "The api key: id is indexed", "is indexed"],
    ["a contraction", "The API token: it's missing from the env.\nWe tried three times.", "We tried three times."]
  ])("keeps the text after %s", (_name, text, kept) => {
    expect(String(Redaction.redact(text))).toContain(kept)
  })
})

describe("redactDiagnostic", () => {
  it.each([
    ["a separated -p value", `sshpass -p ${secret} ssh host`],
    ["an attached -p value", `mysql -u root -p${secret} app`],
    ["an authorization header in any scheme", `Authorization: Token ${secret}`],
    ["bare URL userinfo", `GET https://${secret}@api.example.test/v1`],
    ["a signed query parameter", `GET https://b.example.test/o?X-Amz-Signature=${secret}&x=1`]
  ])("redacts %s", (_name, text) => {
    expectRedacted(Redaction.redactDiagnostic(text))
  })

  it.each([
    ["a multi-word value", `password=correct horse ${secret}`, secret],
    ["a value with , and ; inside it", `DB_PASSWORD=Zq7;Synthetic,${secret}`, secret],
    ["a curl user flag", `curl -u admin:${secret} https://api.example.test`, secret],
    ["a numeric separated -p value", "sshpass -p 123456 ssh host", "123456"],
    ["a lowercase attached -p value", "mysql -psecretvalue app", "secretvalue"],
    ["a credential flag value that starts with -", `deploy --password -${secret}`, secret],
    ["a quoted Digest parameter", `Authorization: Digest username="demo", response="${secret}"`, secret],
    ["a quoted cookie value", `Cookie: a="${secret}"`, secret],
    ["an openssl literal password", `openssl pkcs12 -passin pass:${secret} -in a.p12`, secret],
    ["a quoted attached -p value", `mysql -p'${secret}' db`, secret],
    ["a double-quoted attached -p value", `mysql -p"${secret}" db`, secret],
    ["a -p value that starts with -", `sshpass -p -${secret} ssh host`, secret],
    ["a quoted curl user flag", `curl -u "admin:${secret}" https://e.test`, secret],
    ["a curl password with a comma", `curl -u admin:abc,${secret} https://e.test`, secret],
    ["a -p value with a comma", `sshpass -p abc,${secret} ssh host`, secret],
    ["a credential flag value with a comma", `deploy --password abc,${secret} --verbose`, secret],
    ["an attached -p value with a ]", `mysql -pabc]${secret} db`, secret],
    ["a quoted openssl password", `openssl pkcs12 -passin 'pass:${secret}' -in a.p12`, secret],
    ["an openssl password as two argv elements", inspect(["openssl", "-passin", `pass:${secret}`]), secret],
    ["an openssl enc -pass password", `openssl enc -aes-256-cbc -pass pass:${secret} -in f`, secret],
    ["an sshpass -p value that starts with --", `sshpass -p --${secret} ssh host`, secret],
    ["a plink -pw value", `plink -pw ${secret} user@host`, secret],
    ["a plink -pw value in a JSON argv", JSON.stringify(["plink", "-pw", secret]), secret],
    ["a quoted openssl password holding the other quote", `openssl -passin "pass:abc'${secret}"`, secret],
    ["a plink -pw value that looks like a path", `plink -pw /${secret} host`, secret],
    ["a plink -pw value that starts with --", `plink -pw --${secret} host`, secret],
    ["a -p value with a quoted part written against it", `sshpass -p abc'${secret}' ssh host`, secret],
    ["the words after a placeholder", `password=[REDACTED] ${secret}`, secret],
    ["an inspected header pair", inspect([["Authorization", `Token ${secret}`]]), secret],
    ["a JSON header pair", JSON.stringify([["Proxy-Authorization", `Token ${secret}`]]), secret],
    ["an escaped JSON header pair", JSON.stringify(JSON.stringify([["cookie", `sid=${secret}`]])), secret],
    ["an attached curl user flag", `curl -uadmin:${secret} https://e.test`, secret],
    ["a zip -P value", `zip -r -P ${secret} out.zip dir`, secret],
    ["an unzip -P value", `unzip -P '${secret}' out.zip`, secret],
    ["a zip -P value in a JSON argv", JSON.stringify(["zip", "-P", secret, "out.zip"]), secret],
    ["a redis-cli -a value", `redis-cli -h cache -a ${secret} ping`, secret],
    ["a redis-cli --pass value", `redis-cli --pass ${secret} ping`, secret]
  ])("redacts %s", (_name, text, leak) => {
    const redacted = String(Redaction.redactDiagnostic(text))
    expect(redacted).not.toContain(leak)
    expect(redacted).toContain(Redaction.placeholder)
  })

  it("keeps a header pair's quotes and every other element", () => {
    expect(Redaction.redactDiagnostic(JSON.stringify([["Authorization", `Token ${secret}`], ["Accept", "a"]]))).toBe(
      `[["Authorization","${Redaction.placeholder}"],["Accept","a"]]`
    )
    expect(Redaction.redactDiagnostic(`[ [ 'cookie', 'a=${secret}' ] ]`)).toBe(
      `[ [ 'cookie', '${Redaction.placeholder}' ] ]`
    )
  })

  it("redacts a header pair whose value the text cuts off", () => {
    expect(Redaction.redactDiagnostic(`[["Authorization","Token ${secret}`)).toBe(
      `[["Authorization","${Redaction.placeholder}`
    )
  })

  it.each([
    `password=[REDACTED] ${secret} rest`,
    JSON.stringify([["Authorization", `Token ${secret}`]]),
    `curl -uadmin:${secret} https://e.test`,
    `zip -P ${secret} out.zip`,
    `redis-cli -a ${secret} ping`
  ])("reaches a fixed point on %s", (text) => {
    const once = Redaction.redactDiagnostic(text)
    expect(Redaction.redactDiagnostic(once)).toBe(once)
  })

  it.each([
    "scp -P 2222 file host:",
    "mysql -h db -P 3306 app",
    "sort -u names.txt",
    "mysql -uroot app",
    "zip -r out.zip dir",
    "redis-cli -h cache ping",
    `[["Accept","text/plain"]]`,
    "authorization, then 'retry'"
  ])("keeps %s, which carries no password", (text) => {
    expect(Redaction.redactDiagnostic(text)).toBe(text)
  })

  it("keeps the words after a placeholder in a durable row, where a value is one token", () => {
    expect(Redaction.redact("password=[REDACTED] next")).toBe("password=[REDACTED] next")
  })

  it("redacts a curl user flag held as two argv elements", () => {
    expect(Redaction.redactDiagnostic(["curl", "-u", `admin:${secret}`])).toEqual(["curl", "-u", Redaction.placeholder])
  })

  it.each([
    [["openssl", "pkcs12", "-passin", `pass:${secret}`]],
    [["plink", "-pw", secret]],
    [["app", "-passwd", secret]],
    [["sshpass", "-p", `--${secret}`]]
  ])("redacts the password in the argv %j", (argv) => {
    expect(Redaction.redactDiagnostic(argv)).toEqual([...argv.slice(0, -1), Redaction.placeholder])
  })

  it("keeps the string a command line sits in when its value ends it", () => {
    expect(Redaction.redactDiagnostic(`{"cmd":"mysql -p ${secret}","next":"kept"}`)).toBe(
      `{"cmd":"mysql -p ${Redaction.placeholder}","next":"kept"}`
    )
  })

  it("redacts a -p value held as two argv elements", () => {
    expect(Redaction.redactDiagnostic(["mysql", "-p", secret])).toEqual(["mysql", "-p", Redaction.placeholder])
  })

  it.each(["mkdir -p /tmp/work", "mysql -p --database app", "find . -print", "cc -pthread -pedantic main.c"])(
    "keeps %s, which carries no password",
    (text) => {
      expect(Redaction.redactDiagnostic(text)).toBe(text)
    }
  )
})

describe("lineRedactor", () => {
  const stream = (text: string, redactor = Redaction.lineRedactor()) => {
    const out = text.split("\n").flatMap((line) => redactor.line(line))
    return [...out, ...redactor.flush()]
  }

  it("redacts a private key whose body arrives on its own lines", () => {
    const out = stream(`before\n${pem}\nafter`)
    expect(out).toEqual(["before", Redaction.placeholder, "after"])
  })

  it("redacts every line of an inspected multi-line concatenation", () => {
    expectRedacted(stream(inspect({ privateKey: `${secret}\n`.repeat(8), other: 1 })))
  })

  it("redacts a container a credential name opens across lines", () => {
    const out = stream(JSON.stringify({ apiKey: { a: { b: secret } }, keep: 1 }, null, 2))
    expectRedacted(out)
    expect(out).toContain("  \"keep\": 1")
  })

  it("emits a line no value holds open at once", () => {
    const redactor = Redaction.lineRedactor()
    expect(redactor.line("compiling 3 packages")).toEqual(["compiling 3 packages"])
    expect(redactor.line(`token: ${secret}`)).toEqual([`token: ${Redaction.placeholder}`])
    expect(redactor.flush()).toEqual([])
  })

  it("withholds the rest of the stream once a value stays open past the bound", () => {
    const redactor = Redaction.lineRedactor()
    const out = [...redactor.line("-----BEGIN RSA PRIVATE KEY-----")]
    for (let line = 0; line < Redaction.maxHeldLines * 4; line++) out.push(...redactor.line(`${secret}${line}`))
    out.push(...redactor.flush())
    expectRedacted(out)
    expect(out.length).toBeLessThan(4)
  })

  it("does not take a probe word already on the line for a closed value", () => {
    const out = stream(inspect({ kind: "probe", privateKey: `${secret}\n`.repeat(8) }))
    expectRedacted(out)
  })

  it("keeps a held block from dropping the bracket that opened it", () => {
    const text = [
      "\"credentials\": {",
      "\"a\": {",
      ...Array.from({ length: 300 }, () => "\"x\": 1,"),
      "},",
      `"pass": "${secret}"`
    ]
      .join("\n")
    expect(stream(text).join("\n")).not.toContain(secret)
  })

  it("never emits a line longer than the bound, and withholds after one whose middle opens a value", () => {
    const redactor = Redaction.lineRedactor()
    const filler = "x".repeat(Redaction.maxPartialLine)
    redactor.part(filler)
    redactor.part(" password: { value: \"")
    redactor.part(filler)
    const out = [...redactor.line(""), ...redactor.line(secret), ...redactor.line("\" }"), ...redactor.flush()]
    expect(out.join("\n")).not.toContain(secret)
    expect(out).toContain(Redaction.omittedLine)
  })

  it("keeps a line that arrives in parts whole until its newline", () => {
    const redactor = Redaction.lineRedactor()
    redactor.part("x pass")
    const out = [...redactor.line(`word=${secret}`), ...redactor.flush()]
    expectRedacted(out)
  })

  it("keeps streaming after a long line whose middle closes everything it opens", () => {
    const redactor = Redaction.lineRedactor()
    redactor.part(`{"a":"${"b".repeat(Redaction.maxPartialLine)}"}`)
    expect(redactor.line("")).toEqual([Redaction.omittedLine])
    expect(redactor.line("next line")).toEqual(["next line"])
  })

  it("peeks at what is held without ending the stream", () => {
    const redactor = Redaction.lineRedactor()
    expect(redactor.line("-----BEGIN RSA PRIVATE KEY-----")).toEqual([])
    expect(redactor.line(secret)).toEqual([])
    expect(redactor.peek().join("\n")).not.toContain(secret)
    expect(redactor.line("-----END RSA PRIVATE KEY-----")).toEqual([Redaction.placeholder])
  })

  it("withholds the rest of the stream when a long line's dropped middle opens a key block", () => {
    const redactor = Redaction.lineRedactor()
    const filler = "x".repeat(Redaction.maxPartialLine)
    redactor.part(filler)
    redactor.part(" -----BEGIN RSA PRIVATE KEY----- ")
    redactor.part(filler)
    expect(redactor.line("")).toEqual([Redaction.omittedLine])
    redactor.part(secret)
    expect(redactor.peek()).toEqual([Redaction.placeholder])
    const out = [...redactor.line(secret), ...redactor.line("-----END RSA PRIVATE KEY-----"), ...redactor.flush()]
    expect(out).toEqual([Redaction.placeholder])
  })

  it("keeps streaming after a long line whose dropped middle only ends a key block", () => {
    const redactor = Redaction.lineRedactor()
    const filler = "x".repeat(Redaction.maxPartialLine)
    redactor.part(filler)
    redactor.part(" -----END RSA PRIVATE KEY----- ")
    redactor.part(filler)
    expect(redactor.line("")).toEqual([Redaction.omittedLine])
    expect(redactor.line("next line")).toEqual(["next line"])
  })

  it("replaces held lines when a long risky line arrives while a value is open", () => {
    const redactor = Redaction.lineRedactor()
    const filler = "x".repeat(Redaction.maxPartialLine)
    expect(redactor.line("-----BEGIN RSA PRIVATE KEY-----")).toEqual([])
    expect(redactor.line(secret)).toEqual([])
    redactor.part(filler)
    redactor.part(" password: {\"")
    redactor.part(filler)
    const out = [...redactor.line(""), ...redactor.line(secret), ...redactor.flush()]
    expect(out.join("\n")).not.toContain(secret)
    expect(out).toEqual([Redaction.placeholder, Redaction.omittedLine, Redaction.placeholder])
  })

  it("peeks at nothing on an empty stream and at a pending line as it stands", () => {
    const redactor = Redaction.lineRedactor()
    expect(redactor.peek()).toEqual([])
    redactor.part("compiling")
    expect(redactor.peek()).toEqual(["compiling"])
  })

  it("peeks and flushes a pending overlong line as omitted", () => {
    const redactor = Redaction.lineRedactor()
    redactor.part(`${"x".repeat(Redaction.maxPartialLine)} ${secret}`)
    expect(redactor.peek()).toEqual([Redaction.omittedLine])
    expect(redactor.flush()).toEqual([Redaction.omittedLine])
  })

  it("peeks and flushes a held overlong line as omitted", () => {
    const redactor = Redaction.lineRedactor()
    expect(redactor.line(`${"x".repeat(Redaction.maxPartialLine)} -----BEGIN RSA PRIVATE KEY-----`)).toEqual([])
    expect(redactor.peek()).toEqual([Redaction.omittedLine])
    expect(redactor.line(secret)).toEqual([])
    expect(redactor.flush()).toEqual([Redaction.omittedLine])
  })

  it("redacts a pending line with the held lines on peek and on flush", () => {
    const redactor = Redaction.lineRedactor()
    expect(redactor.line("-----BEGIN RSA PRIVATE KEY-----")).toEqual([])
    redactor.part(secret)
    expect(redactor.peek()).toEqual([Redaction.placeholder])
    expect(redactor.flush()).toEqual([Redaction.placeholder])
  })

  it("redacts a pending line with no newline on flush", () => {
    const redactor = Redaction.lineRedactor()
    redactor.part(`password: ${secret}`)
    expect(redactor.flush()).toEqual([`password: ${Redaction.placeholder}`])
  })

  it("reads rules added while the stream runs", () => {
    const rules: Array<Redaction.Rule> = [...Redaction.diagnosticRules]
    const redactor = Redaction.lineRedactor(rules)
    rules.push({ id: "session", pattern: new RegExp(secret, "g") })
    expect(redactor.line(`echo ${secret}`)).toEqual([`echo ${Redaction.placeholder}`])
  })

  it("holds a long open value in bounded time", () => {
    const redactor = Redaction.lineRedactor()
    const started = Date.now()
    redactor.line("-----BEGIN RSA PRIVATE KEY-----")
    for (let line = 0; line < 2_000; line++) redactor.line("a".repeat(32_000))
    redactor.flush()
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe("the bare-value scanner", () => {
  const leak = "hunter2-synthetic"

  it("reads an inspected new X(...) as one value and keeps the text after it", () => {
    expect(Redaction.redact(`password: new Secret(${leak}) done`)).toBe(`password: ${Redaction.placeholder} done`)
  })

  it("stops a diagnostic value before the next query pair", () => {
    expect(Redaction.redactDiagnostic(`password=${leak}&page=2`)).toBe(`password=${Redaction.placeholder}&page=2`)
  })

  it("keeps an & that is not a query pair inside the value", () => {
    expect(Redaction.redactDiagnostic(`password=Tr0ub(4dor)&3-${leak}`)).toBe(`password=${Redaction.placeholder}`)
  })

  it("ends a header value that is one closed container with the container", () => {
    const out = String(Redaction.redactDiagnostic(`{"cookie":["sid=${leak}"],"page":2}`))
    expect(out).not.toContain(leak)
    expect(out).toBe(`{"cookie":${Redaction.placeholder},"page":2}`)
  })

  it.each([
    ["a header container followed by more of the value", `Cookie: [sid]${leak}`],
    ["an unclosed header container", `Cookie: [sid=${leak}`]
  ])("redacts %s", (_name, text) => {
    expect(Redaction.redactDiagnostic(text)).toBe(`Cookie: ${Redaction.placeholder}`)
  })

  it.each([
    ["before a line end", `password: <${leak}\nnext line`, `password: ${Redaction.placeholder}\nnext line`],
    ["at the end of the text", `password: <${leak}`, `password: ${Redaction.placeholder}`]
  ])("redacts a < that no > closes %s", (_name, text, expected) => {
    expect(Redaction.redact(text)).toBe(expected)
  })

  it("redacts a value that ends the text with a stray quote", () => {
    expect(Redaction.redact(`password: ${leak}'`)).toBe(`password: ${Redaction.placeholder}`)
  })

  it("closes a quoted value at its undoubled quote when only a separator precedes the next name", () => {
    const text = `password="${leak}\\\\", token="second-synthetic"`
    const out = String(Redaction.redact(text))
    expect(out).not.toContain(leak)
    expect(out).not.toContain("second-synthetic")
    expect(out).toBe(`password="${Redaction.placeholder}", token="${Redaction.placeholder}"`)
  })

  it("stops a quoted value at the next name when other text precedes it", () => {
    const out = String(Redaction.redact(`password="${leak}\\\\" then token="second-synthetic"`))
    expect(out).not.toContain(leak)
    expect(out).not.toContain("second-synthetic")
    expect(out).toContain(Redaction.placeholder)
  })

  it("redacts a credential flag whose value is an escaped quoted string", () => {
    const out = String(Redaction.redact(JSON.stringify({ argv: `mysql --password "${leak} two" --verbose` })))
    expect(out).not.toContain(leak)
    expect(out).toContain(Redaction.placeholder)
    expect(out).toContain("--verbose")
  })
})

describe("caller rules", () => {
  it.each([
    ["a positive lookbehind", /(?<=secret=)[\w-]+/g],
    ["a multi-character negative lookbehind", /(?<!keep-)hunter2-synthetic/g]
  ])("still apply a pattern with %s", (_name, pattern) => {
    expect(Redaction.redact("secret=hunter2-synthetic", { rules: [{ id: "caller", pattern }] })).toBe(
      `secret=${Redaction.placeholder}`
    )
  })

  it.each([
    ["after a word boundary", /\b(?<![-_])sk-[\w-]+/g, "error: sk-hunter2-synthetic", "error: [REDACTED]"],
    ["after a literal", /tok(?<![_])=[\w-]+/g, "tok=hunter2-synthetic", "[REDACTED]"],
    ["inside a capture group", /secret=((?<![\\])hunter2[\w-]*)/giu, "SECRET=hunter2-synthetic", "[REDACTED]"],
    ["inside a repeated group", /(?:(?<![x])ab){2}/g, "abab", "[REDACTED]"]
  ])("still apply a one-character lookbehind %s", (_name, pattern, text, expected) => {
    expect(Redaction.redact(text, { rules: [{ id: "caller", pattern }] })).toBe(expected)
  })

  it("keeps text a multi-character negative lookbehind excludes", () => {
    const rules = [{ id: "caller", pattern: /(?<!keep-)hunter2-synthetic/g }]
    expect(Redaction.redact("keep-hunter2-synthetic", { rules })).toBe("keep-hunter2-synthetic")
  })

  it("replaces text whole when the rules never settle", () => {
    expect(Redaction.redact("a hunter2-synthetic", { rules: [{ id: "grow", pattern: /a/g, replace: "aa" }] })).toBe(
      Redaction.placeholder
    )
  })
})

describe("the scanner's cost", () => {
  // The fastest of three runs of each size, interleaved, so a pause in the
  // runner or a busy machine is not read as cost.
  const ratio = (small: () => unknown, large: () => unknown) => {
    const fastest = [Infinity, Infinity]
    for (let run = 0; run < 3; run++) {
      ;[small, large].forEach((task, index) => {
        const started = performance.now()
        task()
        fastest[index] = Math.min(fastest[index]!, performance.now() - started)
      })
    }
    return fastest[1]! / Math.max(fastest[0]!, 1)
  }
  // Four times the input costs about four times as much; a quadratic scan
  // costs sixteen times. Both sizes are past the CPU cache, whose effect
  // would inflate the ratio, and a noisy attempt is retried: garbage
  // collection on a busy machine rarely repeats, a quadratic cost does.
  const bestRatio = (small: () => unknown, large: () => unknown) => {
    let best = Infinity
    for (let attempt = 0; attempt < 3 && best >= 10; attempt++) best = Math.min(best, ratio(small, large))
    return best
  }

  it.each([
    ["header lines", (n: number) => () => Redaction.redactDiagnostic("Authorization: Token a\n".repeat(n))],
    [
      "quoted header boundaries",
      (n: number) => () => Redaction.redactDiagnostic("'Authorization': 'x'\nx'Authorization': ordinary\n".repeat(n))
    ],
    ["unclosed brackets in a durable row", (n: number) => () => Redaction.redact("token: {abc\n".repeat(n))],
    [
      "unclosed parentheses in a durable row",
      (n: number) => () => Redaction.redact("password: (see below\n".repeat(n))
    ],
    [
      "request dumps",
      // A line three to five times as long as the others', so a quarter as many.
      (n: number) => () =>
        Redaction.redactDiagnostic(
          "curl -H 'Authorization: Token x' -u a:b --token t https://h/?sig=1\n".repeat(n / 4)
        )
    ],
    [
      "brackets nested around many quotes (#3088)",
      (n: number) => () => Redaction.redact(`${"[".repeat(n)}${"\"a\" ".repeat(n)} token: x`)
    ]
  ])("grows linearly over %s", (_name, run) => {
    run(500)()
    expect(bestRatio(run(8_000), run(32_000))).toBeLessThan(10)
  })

  // Each unclosed container past its line reads the 4 KiB floor, and the
  // first few read on through the text's scan budget (#3088).
  it("grows linearly over unclosed multi-line containers in a durable row (#3088)", () => {
    const run = (n: number) => () => Redaction.redact("token: {\n  a: 1,\n".repeat(n))
    run(100)()
    expect(bestRatio(run(1_000), run(4_000))).toBeLessThan(10)
  })

  // A held block was re-redacted whole after every line: 255 held lines cost
  // 21 times what 64 did on Node, and about as much on Bun (#3088).
  it("grows linearly over the lines one open value holds (#3088)", () => {
    const hold = (lines: number) => () => {
      for (let block = 0; block < 20; block++) {
        const redactor = Redaction.lineRedactor()
        redactor.line("password: {")
        for (let line = 0; line < lines; line++) redactor.line(`  x: ${"a".repeat(200)},`)
        redactor.line("}")
      }
    }
    hold(16)()
    expect(bestRatio(hold(64), hold(255))).toBeLessThan(10)
  })

  // The dropped middle of an overlong line kept one entry per open bracket:
  // 32 MiB of `[` held 1.7 GB (#3088). Past a fixed depth it is no longer read.
  it("holds bounded state for the middle of an overlong line (#3088)", () => {
    const redactor = Redaction.lineRedactor()
    const chunk = "[".repeat(64 * 1024)
    const before = process.memoryUsage().heapUsed
    for (let part = 0; part < 256; part++) redactor.part(chunk)
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 * 1024)
    expect(redactor.line("")).toEqual([Redaction.omittedLine])
    expect(redactor.line(`token=${secret}`)).toEqual([])
    expect(redactor.flush()).toEqual([Redaction.placeholder])
  })
})

describe("the durable container window (#3088)", () => {
  it("reads a credential-named container past 4 KiB whole", () => {
    const members = Array.from({ length: 300 }, (_, index) => `  field${index}: "value${index}",`).join("\n")
    const row = `apiKey: {\n${members}\n  inner: "${secret}"\n}\nafter: 1`
    expect(row.length).toBeGreaterThan(4096)
    expect(Redaction.redact(row)).toBe(`apiKey: ${Redaction.placeholder}\nafter: 1`)
  })

  it("still stops an unclosed container at its line once the text's scan budget is spent", () => {
    const row = "token: {\n  a: 1,\n".repeat(2_000)
    const out = Redaction.redact(row) as string
    expect(out.split("\n").filter((line) => line === `token: ${Redaction.placeholder}`)).toHaveLength(2_000)
  })
})

describe("a held block past the first lines", () => {
  it("releases every line, redacted as one block, once its value closes", () => {
    const redactor = Redaction.lineRedactor()
    const emitted: Array<string> = [...redactor.line("password: {")]
    for (let line = 0; line < 40; line++) emitted.push(...redactor.line(`  part${line}: ${secret},`))
    emitted.push(...redactor.line("}"))
    for (let line = 0; line < 40; line++) emitted.push(...redactor.line(`plain ${line}`))
    emitted.push(...redactor.flush())
    expect(emitted.join("\n")).not.toContain(secret)
    expect(emitted.at(-1)).toBe("plain 39")
    expect(emitted.filter((line) => line.startsWith("plain "))).toHaveLength(40)
  })
})

describe("the value grammar on hostile input", () => {
  it.each([
    ["unclosed braces", `token: ${"{a".repeat(60_000)}`],
    ["unclosed quotes", `password=${"'a' + ".repeat(40_000)}`],
    ["repeated names", "token: ".repeat(40_000)],
    ["repeated flags", "--token ".repeat(40_000)],
    ["repeated -p", "-p ".repeat(60_000)],
    ["a counter name before long whitespace", `tokens:${" ".repeat(40_000)}1`],
    ["a name before long whitespace", `password:${" ".repeat(200_000)}`],
    ["a header before many newlines", `cookie:${"\n".repeat(200_000)}`],
    ["many quotes in a header value", `Authorization: ${"a\" ".repeat(40_000)}`],
    ["many names in one value", `password=${"x token=".repeat(20_000)}`],
    ["escaped quotes", `\\"password\\":\\"${"\\\\".repeat(60_000)}`],
    ["repeated zip commands", "zip -q ".repeat(40_000)],
    ["repeated redis-cli commands", "redis-cli -h h ".repeat(40_000)],
    ["repeated header pair names", "'cookie', ".repeat(40_000)],
    ["repeated escaped continuations", `password: ${"'a' +\\n ".repeat(40_000)}`]
  ])("scans %s in linear time", (_name, text) => {
    // A quadratic scan of these inputs takes minutes; the budget leaves room
    // for a busy machine. The ratio tests above catch slower growth.
    const started = Date.now()
    Redaction.redactDiagnostic(text)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe("a credential named inside URL userinfo", () => {
  const user = "x-access-token"
  it.each([
    ["a quoted remote", `fatal: unable to access 'https://${user}:${secret}@github.com/acme/private.git/': 403`],
    ["a bare remote", `clone https://${user}:${secret}@github.com/acme/private.git/`],
    ["a parenthesized remote", `at clone (https://${user}:${secret}@github.com/acme/private.git/)`]
  ])("keeps the user name, host and path of %s", (_name, text) => {
    const kept = text.replace(secret, "[REDACTED]")
    for (const redact of [Redaction.redact, Redaction.redactDiagnostic]) expect(redact(text)).toBe(kept)
  })

  it("stops a password that holds an @ at the last @ of the authority", () => {
    const text = `https://${user}:${secret}@a@github.com/acme/p.git?x=@1`
    expect(Redaction.redact(text)).toBe(`https://${user}:[REDACTED]@github.com/acme/p.git?x=@1`)
  })

  it("still redacts the rest of a value that has no userinfo end", () => {
    expectRedacted(Redaction.redact(`https://${user}:${secret}/acme/p.git`), secret)
    expectRedacted(Redaction.redact(`https://${user}:${secret}`), secret)
  })
})

describe("complete authorization header names", () => {
  it.each(["Authorization", "Proxy-Authorization", "AUTHORIZATION", "proxy-authorization"])(
    "redacts whitespace Token credentials for %s only in diagnostics",
    (name) => {
      for (const space of [" ", "\t", "\n"]) {
        const input = `${name}${space}Token ${secret}`
        expect(Redaction.redactDiagnostic(input)).toBe(`${name}${space}[REDACTED]`)
        expect(Redaction.redact(input)).toBe(input)
        expect(Redaction.redactDiagnostic(Redaction.redactDiagnostic(input))).toBe(`${name}${space}[REDACTED]`)
      }
      expect(Redaction.redactDiagnostic(`"${name} Token ${secret}" next`)).toBe(`"${name} [REDACTED]" next`)
    }
  )

  it.each([" ", "\t", " \t "])("redacts same-line Token value whitespace %j", (space) => {
    const input = `Authorization Token${space}${secret}`
    expect(Redaction.redactDiagnostic(input)).toBe(`Authorization [REDACTED]`)
    expect(Redaction.redact(input)).toBe(input)
  })

  it.each(["\n", "\r\n", " \n", "\t\r\n"])("preserves Token prose across value line break %j", (space) => {
    const input = `Authorization Token${space}ordinary prose`
    expect(Redaction.redactDiagnostic(input)).toBe(input)
    expect(Redaction.redact(input)).toBe(input)
  })

  it.each(["Token", "TOKEN", "Bearer", "bearer", "BEARER", "Basic", "BASIC"])(
    "redacts supported whitespace scheme %s",
    (scheme) => {
      for (const space of [" ", "\t", "\n", "\r\n"]) {
        const input = `Proxy-Authorization${space}${scheme} ${secret}`
        const value = /token/i.test(scheme) ?
          "[REDACTED]" :
          `${scheme.toLowerCase() === "basic" ? "Basic" : "Bearer"} [REDACTED_TOKEN]`
        const output = `Proxy-Authorization${space}${value}`
        expect(Redaction.redactDiagnostic(input)).toBe(output)
        expect(Redaction.redactDiagnostic(output)).toBe(output)
      }
    }
  )

  it.each([
    "x-authorization",
    "x.authorization",
    "x+authorization",
    "x!authorization",
    "preauthorization",
    "authorization-extra",
    "x-proxy-authorization"
  ])(
    "preserves extended header name %s",
    (name) => {
      const input = `${name}: ordinary`
      expect(Redaction.redactDiagnostic(input)).toBe(input)
    }
  )

  it.each([
    "Authorization is required",
    "Authorization token policy",
    "Proxy-Authorization header missing",
    "Token ordinary",
    "authorization Tokenization example"
  ])(
    "preserves ordinary prose %s",
    (input) => {
      expect(Redaction.redactDiagnostic(input)).toBe(input)
      expect(Redaction.redact(input)).toBe(input)
    }
  )
})

describe("diagnostic header quote boundaries", () => {
  const names = ["Authorization", "Proxy-Authorization", "AUTHORIZATION", "pRoXy-aUtHoRiZaTiOn"]
  const quotedNames = ["'", "`"].flatMap((quote) => names.map((name) => ({ quote, name })))

  it.each(quotedNames)("preserves $quote inside an extended $name header name", ({ quote, name }) => {
    for (const previous of ["x", "0", "-", "!", "'", "`"]) {
      for (const syntax of [": ordinary", "\t:\tordinary", " = ordinary", " => ordinary", "\tToken ordinary"]) {
        const input = `${previous}${quote}${name}${syntax}`
        expect(Redaction.redactDiagnostic(input)).toBe(input)
      }
    }
  })

  it.each(quotedNames)("preserves $quote extending the end of $name without a quoted key", ({ quote, name }) => {
    for (
      const input of [
        `${name}${quote}: ordinary`,
        `${name}${quote}\t:\tordinary`,
        `${name}${quote}x: ordinary`,
        `${quote}${name}${quote}x${quote}: ordinary`
      ]
    ) {
      expect(Redaction.redactDiagnostic(input)).toBe(input)
    }
  })

  it.each(quotedNames)("redacts standalone $quote-quoted $name keys and strings", ({ quote, name }) => {
    for (const prefix of ["", " ", "\t", "\n", ":", "=", "(", "[", ","]) {
      for (const syntax of [": ", "\t:\t", " = ", " => "]) {
        const key = `${prefix}${quote}${name}${quote}${syntax}`
        const input = `${key}${secret}`
        const expected = `${key}${Redaction.placeholder}`
        expect(Redaction.redactDiagnostic(input)).toBe(expected)
        expect(Redaction.redactDiagnostic(expected)).toBe(expected)
      }
      for (const syntax of [": Token ", "\tToken ", "\r\nTOKEN "]) {
        const input = `${prefix}${quote}${name}${syntax}${secret}${quote}`
        const expected = `${prefix}${quote}${name}${
          syntax.replace(/(?:Token|TOKEN) $/, "")
        }${Redaction.placeholder}${quote}`
        expect(Redaction.redactDiagnostic(input)).toBe(expected)
        expect(Redaction.redactDiagnostic(expected)).toBe(expected)
        expect(Redaction.redact(input)).toBe(input)
      }
    }
  })

  it.each(names)("redacts inspected and escaped JSON standalone %s names", (name) => {
    for (
      const render of [
        (value: unknown) => inspect(value, { breakLength: Infinity }),
        (value: unknown) => JSON.stringify(value),
        (value: unknown) => JSON.stringify(JSON.stringify(value))
      ]
    ) {
      for (
        const [input, expected] of [
          [{ [name]: `Token ${secret}`, kept: "ok" }, { [name]: Redaction.placeholder, kept: "ok" }],
          [{ message: `${name} Token ${secret}`, kept: "ok" }, {
            message: `${name} ${Redaction.placeholder}`,
            kept: "ok"
          }]
        ]
      ) {
        const output = Redaction.redactDiagnostic(render(input))
        expect(output).toBe(render(expected))
        expect(String(output)).not.toContain(secret)
        expect(Redaction.redactDiagnostic(output)).toBe(output)
      }
    }
  })

  it.each(names)("still redacts %s before a double quote without an opener", (name) => {
    // A double quote is not an HTTP token character; retain the existing diagnostic net.
    for (const depth of [0, 1, 3]) {
      const key = `${name}${"\\".repeat(depth)}": `
      const expected = `${key}${Redaction.placeholder}`
      expect(Redaction.redactDiagnostic(`${key}Token ${secret}`)).toBe(expected)
      expect(Redaction.redactDiagnostic(expected)).toBe(expected)
    }
  })

  it.each(["Cookie", "Set-Cookie"])("keeps contextual quote boundaries for %s", (name) => {
    for (const quote of ["'", "`", "\""]) {
      const key = `${quote}${name}${quote}: `
      expect(Redaction.redactDiagnostic(`${key}${secret}`)).toBe(`${key}${Redaction.placeholder}`)
      if (quote !== "\"") {
        for (const input of [`x${quote}${name}: ordinary`, `${name}${quote}: ordinary`]) {
          expect(Redaction.redactDiagnostic(input)).toBe(input)
        }
      }
    }
  })

  it("preserves every HTTP token character extending either end of a header name", () => {
    for (const char of "!#$%&'*+-.^_`|~AZaz09") {
      for (const name of names) {
        for (const input of [`x${char}${name}: ordinary`, `${name}${char}x: ordinary`]) {
          expect(Redaction.redactDiagnostic(input)).toBe(input)
        }
      }
    }
  })

  it("keeps extended names beside independently redacted quoted headers", () => {
    const input =
      `('Authorization': ${secret})\n\`Proxy-Authorization Token ${secret}\`\nx'Authorization: ordinary\nx\`Proxy-Authorization: ordinary`
    const expected =
      `('Authorization': ${Redaction.placeholder})\n\`Proxy-Authorization ${Redaction.placeholder}\`\nx'Authorization: ordinary\nx\`Proxy-Authorization: ordinary`
    expect(Redaction.redactDiagnostic(input)).toBe(expected)
    expect(Redaction.redactDiagnostic(expected)).toBe(expected)
  })
})
