import { target } from "./targets"
import { validateBindings, type Settings } from "./cloudflare"

export const maintenanceNames = ["SMITHERS_EXPORT_TOKEN", "SMITHERS_EXPORT_RECIPIENT", "SMITHERS_EXPORT_EXPIRES_AT", "SMITHERS_EXPORT_SOURCE_REVISION", "SMITHERS_EXPORT_SOURCE_VERSION"] as const
export const requireExportVersion = (deployment: { versions: Array<{ version_id: string; percentage: number }> } | undefined, version: string): void => {
  if (!deployment || deployment.versions.length !== 1 || deployment.versions[0]!.percentage !== 100 || deployment.versions[0]!.version_id !== version) {
    throw new Error("Live maintenance version changed; partial sealed files retained, automatic restore forbidden")
  }
}
// content/v2 serves an ES entry as text/javascript, which the upload API treats
// as classic JavaScript. CF-Entrypoint is the authoritative ES module identity.
export const uploadModuleType = (name: string, type: string, entry: string): string => {
  const mime = type.split(";")[0]!.trim().toLowerCase()
  if (name !== entry) return mime
  if (!["text/javascript", "application/javascript", "text/javascript+module", "application/javascript+module"].includes(mime)) throw new Error("Original entrypoint is not a JavaScript module")
  return "application/javascript+module"
}
export const uploadedVersion = (result: { deployment_id?: string }): string => {
  const raw = result.deployment_id?.replaceAll("-", "")
  if (!raw || !/^[a-f0-9]{32}$/i.test(raw)) throw new Error("Upload did not identify its exact version")
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toLowerCase()
}
export const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`
  return JSON.stringify(value)
}
export const metadataFor = (settings: Settings, main: string, additions: Record<string, string> = {}) => {
  validateBindings(settings)
  if (settings.bindings.some(binding => maintenanceNames.includes(binding.name as typeof maintenanceNames[number]))) throw new Error("Maintenance binding already exists")
  const originalAnnotations = settings.annotations && typeof settings.annotations === "object" ? settings.annotations as Record<string, unknown> : {}
  // triggered_by is platform-owned. Preserve the original source message/tag on restore.
  const annotations = Object.fromEntries(Object.entries(originalAnnotations).filter(([name, value]) =>
    ["workers/message", "workers/tag"].includes(name) && typeof value === "string"))
  // No migrations, routes, domains, secret replacement, or asset upload occurs.
  return { ...Object.fromEntries(Object.entries(settings).filter(([name]) => ["placement", "compatibility_date", "compatibility_flags", "usage_model", "tags", "tail_consumers", "logpush", "observability"].includes(name))),
    main_module: main, keep_assets: true, keep_bindings: ["secret_text"],
    bindings: [...settings.bindings.filter(binding => binding.type !== "secret_text"),
      ...Object.entries(additions).map(([name, text]) => ({ name, type: "secret_text", text }))],
    annotations: additions.SMITHERS_EXPORT_SOURCE_REVISION
      ? { "workers/message": `temporary sealed inventory over ${additions.SMITHERS_EXPORT_SOURCE_REVISION}`, "workers/tag": "sealed-state-inventory" }
      : annotations
  }
}
export const wrapperFor = (entry: string): string => {
  if (!/^[a-zA-Z0-9_.-]+\.js$/.test(entry)) throw new Error("Live entrypoint requires manual review")
  return `import legacy, { ${target.durableObjects.map(item => `${item.className} as Legacy${item.className}`).join(", ")} } from ${JSON.stringify("./" + entry)};
export * from ${JSON.stringify("./" + entry)};
import { EXPORT_PATH, maintenanceExport, withSealedExport } from "./sealed-export-helper.js";
${target.durableObjects.map(item => `export class ${item.className} extends withSealedExport(Legacy${item.className}, ${JSON.stringify(item.binding)}) {}`).join("\n")}
export default { ...legacy, fetch(request, env, ctx) { return new URL(request.url).pathname === EXPORT_PATH ? maintenanceExport(request, env) : legacy.fetch(request, env, ctx); } };
`
}
