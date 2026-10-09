import { defineConfig } from "@playwright/test"
import t1 from "./playwright.config"

/*
 * The install tier (//apps/app:installE2e): the T1 specs tagged @install,
 * which start a real install through the Go backend harness (go test
 * ./internal/compose, startLocalOwn) against PostgreSQL 18 and a test
 * database. Same host and browser as T1; scripts/run-install-e2e.ts checks
 * the toolchain before Playwright starts.
 */
export default defineConfig({ ...t1, grep: /@install/, grepInvert: undefined })
