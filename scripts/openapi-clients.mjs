#!/usr/bin/env node
/**
 * Generates the Go and TypeScript product API clients from the bundled
 * docs/api/openapi.yaml.
 *
 * Both clients are plain code over the standard library (`net/http` and
 * `encoding/json` in Go; `encodeURIComponent` and `URLSearchParams` in
 * TypeScript), so neither adds a runtime dependency. The TypeScript client
 * sends through a `Transport` the caller supplies (the CLI's backend `Client`
 * is one), which keeps authentication, redaction, and error handling where
 * they already live.
 *
 * Every schema becomes a named type, every operation one function. An
 * operation whose request body is not JSON is left out and listed in each
 * file's header. Header and cookie parameters are the transport's business
 * and never appear in a signature.
 *
 * `//:openapiClients` runs this script; `lint` fails when a committed client
 * differs from what the bundle produces. `--check` does the same comparison
 * without the build tool and exits non-zero on drift.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

const fail = (message) => {
  throw new Error(`openapi-clients: ${message}`)
}

/** Splits an identifier such as `created_at`, `GitHubApp` or `get_api_user_keys_id` into words. */
export const words = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")

const upper = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

/** The TypeScript function name of an operation: `get_api_user_keys_id` is `getApiUserKeysId`. */
export const tsFunction = (operationId) => {
  const [first = "", ...rest] = words(operationId)
  return first.toLowerCase() + rest.map(upper).join("")
}

/** A PascalCase TypeScript type name: `get_api_status` is `GetApiStatus`. */
export const tsTypeName = (name) => words(name).map(upper).join("")

const initialisms = new Set([
  "api", "id", "ids", "url", "urls", "uri", "http", "https", "ssh", "json", "sha", "ip", "ui", "html", "sql", "tls",
  "oauth", "sse", "ci", "ttl", "cpu", "uuid", "db", "dns", "vm", "os", "io"
])
const initialismCase = new Map([["ids", "IDs"], ["urls", "URLs"], ["oauth", "OAuth"]])

/** A Go exported identifier with Go's initialisms: `get_api_user_keys_id` is `GetAPIUserKeysID`. */
export const goName = (name) => {
  const result = words(name)
    .map((word) => {
      const lower = word.toLowerCase()
      if (initialismCase.has(lower)) return initialismCase.get(lower)
      if (initialisms.has(lower)) return lower.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join("")
  if (result === "") fail(`${JSON.stringify(name)} has no Go name`)
  return /^[0-9]/.test(result) ? `X${result}` : result
}

const refName = (ref) => {
  const match = /^#\/components\/(schemas|responses)\/([^/]+)$/.exec(ref)
  if (match === null) fail(`unsupported $ref ${ref}`)
  return { kind: match[1], name: match[2] }
}

/** The document's operations in path order, each with its resolved success and body shapes. */
export const operations = (document) => {
  const result = []
  const seen = new Set()
  const responses = document.components?.responses ?? {}
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of methods) {
      const operation = item[method]
      if (operation === undefined) continue
      const id = operation.operationId
      if (typeof id !== "string" || id === "") fail(`${method} ${path} has no operationId`)
      if (seen.has(id)) fail(`operationId ${id} is declared twice`)
      seen.add(id)
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
      const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
      const pathParameters = pathNames.map((name) => {
        const parameter = parameters.find((candidate) => candidate.in === "path" && candidate.name === name)
        if (parameter === undefined) fail(`${id} does not declare path parameter ${name}`)
        return parameter
      })
      const query = parameters.filter((parameter) => parameter.in === "query")
      let success = { kind: "none" }
      let empty = false
      const codes = Object.keys(operation.responses ?? {}).filter((code) => /^2/.test(code)).sort()
      for (const code of codes) {
        let response = operation.responses[code]
        if (response.$ref !== undefined) response = responses[refName(response.$ref).name] ?? fail(`${id} ${code} is missing`)
        const content = response.content ?? {}
        const types = Object.keys(content)
        if (types.length === 0) {
          empty = true
          continue
        }
        if (types.includes("application/json")) {
          if (success.kind === "raw") fail(`${id} mixes JSON and non-JSON success responses`)
          if (success.kind === "json") fail(`${id} declares more than one JSON success response`)
          success = { kind: "json", schema: content["application/json"].schema ?? {} }
        } else {
          if (success.kind === "json") fail(`${id} mixes JSON and non-JSON success responses`)
          success = { kind: "raw", accept: types.join(", ") }
        }
      }
      // A JSON operation that may also answer with no body resolves to null then.
      if (success.kind === "json" && empty) success = { ...success, empty: true }
      const requestBody = operation.requestBody
      let body
      let skipped
      if (requestBody !== undefined) {
        const types = Object.keys(requestBody.content ?? {})
        if (types.includes("application/json")) {
          body = { schema: requestBody.content["application/json"].schema ?? {}, required: requestBody.required === true }
        } else skipped = types.join(", ")
      }
      result.push({ id, method, path, summary: operation.summary, pathParameters, query, success, body, skipped })
    }
  }
  return result
}

const types = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type])

// ---------------------------------------------------------------- TypeScript

const tsProperty = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name))

const tsLiteral = (value) => JSON.stringify(value)

/** `name` read from `object`: `input.path.id`, or `input.path["run-id"]`; `optional` chains with `?.`. */
const tsMember = (object, name, optional = false) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${object}${optional ? "?." : "."}${name}` : `${object}${optional ? "?." : ""}[${JSON.stringify(name)}]`

/** The TypeScript type of `schema`, indented for nesting at `indent`. */
export const tsType = (schema, indent = "") => {
  if (schema === undefined || schema === null || schema === true) return "unknown"
  if (schema === false) return "never"
  if (schema.$ref !== undefined) return refName(schema.$ref).name
  if (schema.const !== undefined) return tsLiteral(schema.const)
  if (Array.isArray(schema.enum)) return schema.enum.map(tsLiteral).join(" | ")
  const union = schema.oneOf ?? schema.anyOf
  if (Array.isArray(union)) return union.map((member) => wrap(tsType(member, indent))).join(" | ")
  if (Array.isArray(schema.allOf)) return schema.allOf.map((member) => wrap(tsType(member, indent))).join(" & ")
  const list = types(schema)
  if (list.length === 0) return schema.properties === undefined ? "unknown" : tsObject(schema, indent)
  return list.map((type) => {
    switch (type) {
      case "string":
        return "string"
      case "integer":
      case "number":
        return "number"
      case "boolean":
        return "boolean"
      case "null":
        return "null"
      case "array":
        return `Array<${tsType(schema.items, indent)}>`
      case "object":
        return tsObject(schema, indent)
      default:
        return fail(`unsupported type ${type}`)
    }
  }).join(" | ")
}

const wrap = (type) => (/[|&]/.test(type) && !type.startsWith("{") ? `(${type})` : type)

const tsObject = (schema, indent) => {
  const inner = `${indent}  `
  const required = new Set(schema.required ?? [])
  const lines = Object.entries(schema.properties ?? {}).map(
    ([name, property]) => `${inner}${tsProperty(name)}${required.has(name) ? "" : "?"}: ${tsType(property, inner)}`
  )
  const extra = schema.additionalProperties
  if (lines.length === 0) {
    if (extra === false) return "Record<string, never>"
    return `Record<string, ${extra === undefined || extra === true ? "unknown" : tsType(extra, indent)}>`
  }
  if (extra !== undefined && extra !== false) lines.push(`${inner}[key: string]: unknown`)
  return `{\n${lines.join("\n")}\n${indent}}`
}

const doc = (text) => `/** ${String(text).replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim()} */`

const tsHeader = (skipped) => [
  "// Code generated by scripts/openapi-clients.mjs from docs/api/openapi.yaml. DO NOT EDIT.",
  "// Regenerate with `smthrs run //:openapiClients`.",
  ...(skipped.length === 0 ? [] : ["//", "// Not generated (the request body is not JSON):", ...skipped.map((operation) => `//   ${operation.id} (${operation.skipped})`)]),
  ""
]

/** Renders the TypeScript client. */
export const typescript = (document) => {
  const all = operations(document)
  const out = tsHeader(all.filter((operation) => operation.skipped !== undefined))
  out.push(
    doc("Sends one product API request. The CLI's backend `Client` is one; so is anything with these two methods."),
    "export interface Transport {",
    "  /** Sends a JSON request and resolves to the parsed JSON response, or null when it has no body. */",
    "  request(method: string, path: string, body?: unknown): Promise<unknown>",
    "  /** Sends a request and resolves to the raw response, for streams and files. */",
    "  response(method: string, path: string, body?: unknown): Promise<Response>",
    "}",
    "",
    "const segment = (value: string | number): string => encodeURIComponent(String(value))",
    "",
    "const search = (values: Record<string, string | number | boolean | undefined>): string => {",
    "  const query = new URLSearchParams()",
    "  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value))",
    "  return query.size === 0 ? \"\" : `?${query}`",
    "}",
    ""
  )
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    if (schema.description !== undefined) out.push(doc(schema.description))
    out.push(`export type ${name} = ${tsType(schema)}`, "")
  }
  const functions = new Set()
  for (const operation of all) {
    if (operation.skipped !== undefined) continue
    const base = tsTypeName(operation.id)
    if (functions.has(base)) fail(`operationId ${operation.id} has the same TypeScript name as another operation`)
    functions.add(base)
    const fields = []
    let optional = true
    if (operation.pathParameters.length > 0) {
      optional = false
      const members = operation.pathParameters.map((parameter) => `readonly ${tsProperty(parameter.name)}: ${tsType(parameter.schema)}`)
      fields.push(`  readonly path: { ${members.join("; ")} }`)
    }
    if (operation.query.length > 0) {
      const required = operation.query.some((parameter) => parameter.required === true)
      if (required) optional = false
      const members = operation.query.map(
        (parameter) => `readonly ${tsProperty(parameter.name)}${parameter.required === true ? "" : "?"}: ${tsType(parameter.schema)}`
      )
      fields.push(`  readonly query${required ? "" : "?"}: { ${members.join("; ")} }`)
    }
    if (operation.body !== undefined) {
      if (operation.body.required) optional = false
      out.push(`export type ${base}Body = ${tsType(operation.body.schema)}`, "")
      fields.push(`  readonly body${operation.body.required ? "" : "?"}: ${base}Body`)
    }
    let result = "void"
    if (operation.success.kind === "json") {
      out.push(`export type ${base}Response = ${tsType(operation.success.schema)}`, "")
      result = `${base}Response${operation.success.empty ? " | null" : ""}`
    } else if (operation.success.kind === "raw") result = "Response"
    if (fields.length > 0) out.push(`export interface ${base}Input {`, ...fields, "}", "")
    const queryObject = tsMember("input", "query", optional)
    const queryOptional = !operation.query.some((parameter) => parameter.required === true)
    const query = operation.query.length === 0
      ? ""
      : `\${search({ ${operation.query.map((parameter) => `${tsProperty(parameter.name)}: ${tsMember(queryObject, parameter.name, queryOptional)}`).join(", ")} })}`
    const path = `\`${operation.path.replace(/\{([^}]+)\}/g, (_, name) => `\${segment(${tsMember("input.path", name)})}`)}${query}\``
    const args = `"${operation.method.toUpperCase()}", ${path}${operation.body !== undefined ? `, ${tsMember("input", "body", optional)}` : ""}`
    const call = operation.success.kind === "raw"
      ? `transport.response(${args})`
      : operation.success.kind === "json"
      ? `transport.request(${args}) as Promise<${result}>`
      : `transport.request(${args}).then(() => undefined)`
    const label = `${operation.method.toUpperCase()} ${operation.path}`
    const parameter = fields.length === 0 ? "" : `, input${optional ? "?" : ""}: ${base}Input`
    out.push(
      doc(operation.summary && operation.summary !== label ? `${label}: ${operation.summary}` : label),
      `export const ${tsFunction(operation.id)} = (transport: Transport${parameter}): Promise<${result}> =>`,
      `  ${call}`,
      ""
    )
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`
}

// ---------------------------------------------------------------------- Go

class GoTypes {
  constructor(document) {
    this.schemas = document.components?.schemas ?? {}
    this.declarations = []
    // The runtime's own declarations, so a schema of the same name fails loudly.
    this.names = new Set(["Doer", "Client", "ResponseError"])
    this.imports = new Set(["bytes", "context", "encoding/json", "fmt", "io", "net/http", "net/url", "strings"])
  }

  claim(name) {
    if (this.names.has(name)) fail(`Go type ${name} is declared twice`)
    this.names.add(name)
    return name
  }

  /** Whether `schema` has no Go shape beyond raw JSON (unknown, a union, or several types). */
  raw(schema) {
    if (schema === undefined || schema === null || typeof schema !== "object") return true
    if (schema.$ref !== undefined) return this.raw(this.schemas[refName(schema.$ref).name])
    if (schema.oneOf || schema.anyOf || schema.allOf) return true
    const list = types(schema).filter((type) => type !== "null")
    if (list.length > 1) return true
    return list.length === 0 && schema.properties === undefined && schema.const === undefined && schema.enum === undefined
  }

  /** Whether a Go value of `schema` already has an empty state (slice, map, raw JSON). */
  nilable(schema) {
    if (schema === undefined || schema === null || typeof schema !== "object") return true
    if (schema.$ref !== undefined) return this.nilable(this.schemas[refName(schema.$ref).name])
    if (schema.oneOf || schema.anyOf || schema.allOf) return true
    const list = types(schema).filter((type) => type !== "null")
    if (list.length !== 1) return list.length === 0 ? schema.properties === undefined : true
    if (list[0] === "array") return true
    if (list[0] === "object") return schema.properties === undefined || Object.keys(schema.properties).length === 0
    return false
  }

  /** The Go type of `schema`; an inline object with properties is declared as `hint`. */
  type(schema, hint) {
    if (schema === undefined || schema === null || schema === true || schema === false) return "json.RawMessage"
    if (schema.$ref !== undefined) return goName(refName(schema.$ref).name)
    if (schema.oneOf || schema.anyOf || schema.allOf) return "json.RawMessage"
    const list = types(schema).filter((type) => type !== "null")
    if (list.length === 0 && schema.const !== undefined) {
      return typeof schema.const === "string" ? "string" : typeof schema.const === "boolean" ? "bool" : "json.RawMessage"
    }
    if (list.length === 0 && schema.enum !== undefined) return schema.enum.every((value) => typeof value === "string") ? "string" : "json.RawMessage"
    if (list.length !== 1) return list.length === 0 && schema.properties !== undefined ? this.struct(schema, hint) : "json.RawMessage"
    const nullable = types(schema).includes("null")
    const base = (() => {
      switch (list[0]) {
        case "string":
          if (schema.format === "date-time") {
            this.imports.add("time")
            return "time.Time"
          }
          return "string"
        case "integer":
          return schema.format === "int32" ? "int32" : "int64"
        case "number":
          return "float64"
        case "boolean":
          return "bool"
        case "array":
          return `[]${this.type(schema.items, `${hint}Item`)}`
        case "object":
          if (schema.properties === undefined || Object.keys(schema.properties).length === 0) {
            const extra = schema.additionalProperties
            return extra === undefined || extra === true || extra === false ? "map[string]json.RawMessage" : `map[string]${this.type(extra, `${hint}Value`)}`
          }
          return this.struct(schema, hint)
        default:
          return fail(`unsupported type ${list[0]}`)
      }
    })()
    return nullable && !this.nilable({ ...schema, type: list[0] }) ? `*${base}` : base
  }

  /**
   * Declares `name` for an inline object schema and returns the name. Its slot
   * is reserved first, so it precedes the nested types its fields declare.
   */
  struct(schema, name) {
    this.claim(name)
    const at = this.declarations.push(undefined) - 1
    this.declarations[at] = this.structDeclaration(schema, name)
    return name
  }

  structDeclaration(schema, name, description) {
    const required = new Set(schema.required ?? [])
    const fields = []
    const used = new Set()
    for (const [property, value] of Object.entries(schema.properties ?? {})) {
      let field = goName(property)
      while (used.has(field)) field = `${field}_`
      used.add(field)
      let type = this.type(value, `${name}${goName(property)}`)
      const optional = !required.has(property)
      if (optional && !type.startsWith("*") && !this.nilable(value)) type = `*${type}`
      fields.push([field, type, `\`json:"${property}${optional ? ",omitempty" : ""}"\``])
    }
    // Members the schema allows but does not declare survive a round trip.
    const extra = schema.additionalProperties !== undefined && schema.additionalProperties !== false && fields.length > 0
    let extraField = "AdditionalProperties"
    while (used.has(extraField)) extraField = `${extraField}_`
    if (extra) fields.push([extraField, "map[string]json.RawMessage", "`json:\"-\"`"])
    const lines = [
      `// ${name} ${description === undefined ? "is generated from docs/api/openapi.yaml." : goComment(description)}`
    ]
    if (fields.length === 0) {
      lines.push(`type ${name} struct{}`)
      return lines.join("\n")
    }
    const nameWidth = Math.max(...fields.map((field) => field[0].length))
    const typeWidth = Math.max(...fields.map((field) => field[1].length))
    lines.push(`type ${name} struct {`)
    for (const [field, type, tag] of fields) lines.push(`\t${field.padEnd(nameWidth)} ${type.padEnd(typeWidth)} ${tag}`)
    lines.push("}")
    if (extra) {
      const declared = Object.keys(schema.properties).map(goString).join(", ")
      lines.push(
        "",
        `// UnmarshalJSON keeps the members ${name} does not declare in ${extraField}.`,
        `func (v *${name}) UnmarshalJSON(data []byte) error {`,
        `\ttype plain ${name}`,
        "\tif err := json.Unmarshal(data, (*plain)(v)); err != nil {",
        "\t\treturn err",
        "\t}",
        `\treturn splitAdditional(data, &v.${extraField}, ${declared})`,
        "}",
        "",
        `// MarshalJSON writes ${extraField} beside the declared members of ${name}.`,
        `func (v ${name}) MarshalJSON() ([]byte, error) {`,
        `\ttype plain ${name}`,
        `\treturn joinAdditional(plain(v), v.${extraField})`,
        "}"
      )
    }
    return lines.join("\n")
  }

  /** Declares a component schema under its Go name. */
  component(name, schema) {
    const go = this.claim(goName(name))
    const list = types(schema).filter((type) => type !== "null")
    const at = this.declarations.push(undefined) - 1
    if (list.length <= 1 && (list[0] === "object" || list.length === 0) && schema.properties !== undefined && Object.keys(schema.properties).length > 0 && !schema.oneOf && !schema.anyOf && !schema.allOf) {
      this.declarations[at] = this.structDeclaration(schema, go, schema.description)
      return
    }
    const type = this.type(schema, `${go}Value`)
    const alias = type === "json.RawMessage" || type.startsWith("map[") || type.startsWith("[]") || type.startsWith("*")
    this.declarations[at] = `// ${go} ${schema.description === undefined ? "is generated from docs/api/openapi.yaml." : goComment(schema.description)}\ntype ${go} ${alias ? "= " : ""}${type}`
  }
}

const goComment = (text) => `— ${String(text).replace(/\s+/g, " ").trim()}`

const goString = (value) => JSON.stringify(value)

const goParameterValue = (types, parameter, expression) => {
  const type = types.type(parameter.schema, "Parameter")
  if (type === "string") return expression
  if (type === "int64") return `strconv.FormatInt(${expression}, 10)`
  if (type === "int32") return `strconv.FormatInt(int64(${expression}), 10)`
  if (type === "bool") return `strconv.FormatBool(${expression})`
  if (type === "float64") return `strconv.FormatFloat(${expression}, 'g', -1, 64)`
  if (type === "time.Time") return `${expression.startsWith("*") ? `(${expression})` : expression}.Format(time.RFC3339Nano)`
  return fail(`parameter ${parameter.name} has unsupported Go type ${type}`)
}

const goParameterName = (name) => {
  const go = goName(name)
  const lower = go.charAt(0).toLowerCase() + go.slice(1)
  const initial = /^[A-Z]{2,}/.exec(go)
  const result = initial === null ? lower : initial[0].length === go.length ? go.toLowerCase() : initial[0].slice(0, -1).toLowerCase() + go.slice(initial[0].length - 1)
  return ["type", "func", "var", "map", "range", "go", "select", "case", "default", "chan", "interface", "package", "import", "return", "struct", "const", "ctx", "c", "query", "body", "out", "err", "path"].includes(result) ? `${result}Param` : result
}

/** Renders the Go client. */
export const go = (document) => {
  const all = operations(document)
  const types = new GoTypes(document)
  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) types.component(name, schema)
  const methods = []
  const functions = new Set()
  for (const operation of all) {
    if (operation.skipped !== undefined) continue
    const name = goName(operation.id)
    if (functions.has(name)) fail(`operationId ${operation.id} has the same Go name as another operation`)
    functions.add(name)
    const params = ["ctx context.Context"]
    const pathExpression = []
    let cursor = 0
    for (const match of operation.path.matchAll(/\{([^}]+)\}/g)) {
      const parameter = operation.pathParameters.find((candidate) => candidate.name === match[1])
      const variable = goParameterName(parameter.name)
      params.push(`${variable} ${types.type(parameter.schema, `${name}${goName(parameter.name)}`)}`)
      if (match.index > cursor) pathExpression.push(goString(operation.path.slice(cursor, match.index)))
      pathExpression.push(`url.PathEscape(${goParameterValue(types, parameter, variable)})`)
      cursor = match.index + match[0].length
    }
    const rest = operation.path.slice(cursor)
    if (rest !== "" || pathExpression.length === 0) pathExpression.push(goString(rest))
    const body = []
    if (operation.query.length > 0) {
      const required = new Set(operation.query.filter((parameter) => parameter.required === true).map((parameter) => parameter.name))
      const fields = operation.query.map((parameter) => {
        let type = types.type(parameter.schema, `${name}${goName(parameter.name)}`)
        if (!required.has(parameter.name)) type = `*${type}`
        return [goName(parameter.name), type, parameter]
      })
      const nameWidth = Math.max(...fields.map((field) => field[0].length))
      types.claim(`${name}Params`)
      types.declarations.push([
        `// ${name}Params is the query of ${operation.method.toUpperCase()} ${operation.path}.`,
        `type ${name}Params struct {`,
        ...fields.map(([field, type]) => `\t${field.padEnd(nameWidth)} ${type}`),
        "}"
      ].join("\n"))
      params.push(`params ${name}Params`)
      body.push("\tquery := url.Values{}")
      for (const [field, type, parameter] of fields) {
        if (type.startsWith("*")) {
          body.push(`\tif params.${field} != nil {`, `\t\tquery.Set(${goString(parameter.name)}, ${goParameterValue(types, parameter, `*params.${field}`)})`, "\t}")
        } else body.push(`\tquery.Set(${goString(parameter.name)}, ${goParameterValue(types, parameter, `params.${field}`)})`)
      }
    }
    const query = operation.query.length > 0 ? "query" : "nil"
    let bodyArgument = "nil"
    if (operation.body !== undefined) {
      if (types.raw(operation.body.schema)) {
        params.push("body any")
        bodyArgument = "body"
      } else {
        const type = types.type(operation.body.schema, `${name}Body`)
        params.push(`body ${operation.body.required ? type : `*${type}`}`)
        bodyArgument = operation.body.required ? "body" : "optionalBody(body)"
      }
    }
    const path = pathExpression.join("+")
    const summary = `// ${name} calls ${operation.method.toUpperCase()} ${operation.path}.`
    const method = goString(operation.method.toUpperCase())
    if (operation.success.kind === "json") {
      const type = types.type(operation.success.schema, `${name}Response`)
      methods.push([
        summary,
        `func (c *Client) ${name}(${params.join(", ")}) (${type}, error) {`,
        ...body,
        `\tvar out ${type}`,
        `\terr := c.do(ctx, ${method}, ${path}, ${query}, ${bodyArgument}, &out)`,
        "\treturn out, err",
        "}"
      ].join("\n"))
    } else if (operation.success.kind === "raw") {
      methods.push([
        `${summary} The caller closes the response body.`,
        `func (c *Client) ${name}(${params.join(", ")}) (*http.Response, error) {`,
        ...body,
        `\treturn c.raw(ctx, ${method}, ${path}, ${query}, ${bodyArgument}, ${goString(operation.success.accept)})`,
        "}"
      ].join("\n"))
    } else {
      methods.push([
        summary,
        `func (c *Client) ${name}(${params.join(", ")}) error {`,
        ...body,
        `\treturn c.do(ctx, ${method}, ${path}, ${query}, ${bodyArgument}, nil)`,
        "}"
      ].join("\n"))
    }
  }
  const text = [...types.declarations, ...methods].join("\n\n")
  if (/\bstrconv\./.test(text)) types.imports.add("strconv")
  if (/\btime\./.test(text)) types.imports.add("time")
  const skipped = all.filter((operation) => operation.skipped !== undefined)
  const header = [
    "// Code generated by scripts/openapi-clients.mjs from docs/api/openapi.yaml. DO NOT EDIT.",
    "// Regenerate with `smthrs run //:openapiClients`.",
    ...(skipped.length === 0 ? [] : ["//", "// Not generated (the request body is not JSON):", ...skipped.map((operation) => `//   ${operation.id} (${operation.skipped})`)]),
    "",
    "// Package apiclient is the typed Go client of the Smithers product API.",
    "package apiclient",
    "",
    "import (",
    ...[...types.imports].sort().map((name) => `\t${goString(name)}`),
    ")",
    ""
  ]
  const helpers = [
    ...(/optionalBody\(/.test(text) ? [optionalBody] : []),
    ...(/splitAdditional\(/.test(text) ? [additional] : [])
  ]
  return `${[...header, runtime, ...helpers, text].join("\n")}\n`
}

const optionalBody = `func optionalBody[T any](body *T) any {
	if body == nil {
		return nil
	}
	return body
}
`

const additional = `// splitAdditional stores the members of data not named in declared in *extra.
func splitAdditional(data []byte, extra *map[string]json.RawMessage, declared ...string) error {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for _, name := range declared {
		delete(all, name)
	}
	if len(all) == 0 {
		all = nil
	}
	*extra = all
	return nil
}

// joinAdditional encodes value with the members of extra it does not already have.
func joinAdditional(value any, extra map[string]json.RawMessage) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil || len(extra) == 0 {
		return data, err
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	for name, raw := range extra {
		if _, ok := all[name]; !ok {
			all[name] = raw
		}
	}
	return json.Marshal(all)
}
`

const runtime = `// Doer sends one HTTP request; *http.Client is one.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// Client calls the Smithers product API at BaseURL through HTTPClient (nil
// uses http.DefaultClient), adding Header to every request.
type Client struct {
	BaseURL    string
	HTTPClient Doer
	Header     http.Header
}

// ResponseError is a response outside 2xx.
type ResponseError struct {
	Method     string
	Path       string
	StatusCode int
	Body       []byte
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("%s %s -> %d: %s", e.Method, e.Path, e.StatusCode, strings.TrimSpace(string(e.Body)))
}

func (c *Client) send(ctx context.Context, method, path string, query url.Values, body any, accept string) (*http.Response, error) {
	target := strings.TrimSuffix(c.BaseURL, "/") + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("%s %s: encode body: %w", method, path, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	for key, values := range c.Header {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	request.Header.Set("Accept", accept)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	doer := c.HTTPClient
	if doer == nil {
		doer = http.DefaultClient
	}
	response, err := doer.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		defer response.Body.Close()
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return nil, &ResponseError{Method: method, Path: path, StatusCode: response.StatusCode, Body: detail}
	}
	return response, nil
}

func (c *Client) raw(ctx context.Context, method, path string, query url.Values, body any, accept string) (*http.Response, error) {
	return c.send(ctx, method, path, query, body, accept)
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	response, err := c.send(ctx, method, path, query, body, "application/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("%s %s: read response: %w", method, path, err)
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", method, path, err)
	}
	return nil
}
`

// --------------------------------------------------------------------- files

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The spec this repository commits and the clients generated from it. */
export const layout = {
  spec: resolve(repository, "docs/api/openapi.yaml"),
  typescript: resolve(repository, "packages/smithers/src/internal/backend/ProductApi.ts"),
  go: resolve(repository, "packages/backend/apiclient/client.gen.go")
}

/** Both clients for the bundle text `spec`, keyed by their `layout` path. */
export const generate = (spec) => {
  const document = parse(spec)
  return new Map([[layout.typescript, typescript(document)], [layout.go, go(document)]])
}

/** The committed clients that differ from what the committed spec produces. */
export const stale = () =>
  [...generate(readFileSync(layout.spec, "utf8"))].filter(([file, text]) => {
    try {
      return readFileSync(file, "utf8") !== text
    } catch {
      return true
    }
  }).map(([file]) => relative(repository, file))

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const files = stale()
    for (const file of files) process.stderr.write(`${file} is stale; run \`smthrs run //:openapiClients\`\n`)
    process.exitCode = files.length === 0 ? 0 : 1
  } else {
    for (const [file, text] of generate(readFileSync(layout.spec, "utf8"))) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
      process.stdout.write(`wrote ${relative(repository, file)}\n`)
    }
  }
}
