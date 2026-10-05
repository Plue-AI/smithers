/*
 * The docs this build ships: Vite inlines every pages/*.md file as text at
 * build time. Bun's test runner has no import.meta.glob, so nothing under
 * test calls this; suites pass the same files from DiskPages.ts through the
 * controller's `docs` service instead.
 */
import { loadDocs, type Docs } from "./Docs"

let docs: Docs | undefined

export const bundledDocs = (): Docs =>
  docs ??= loadDocs(import.meta.glob<string>("./pages/*.md", { query: "?raw", import: "default", eager: true }))
