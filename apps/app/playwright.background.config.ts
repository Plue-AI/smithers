import { defineConfig } from "@playwright/test"
import local from "./playwright.local.config"
export default defineConfig({ ...local,
 projects: [
  { name: "setup", testMatch: "**/setup-no-github.spec.ts", grep: /[1-7] (?:address|app_manifest|sign_in|repository|models|source|machine)/ },
  { name: "background", testMatch: "**/background-runs.spec.ts", dependencies: ["setup"] }
 ],
 use: { ...local.use, video: "on", trace: "retain-on-failure" },
 webServer: { ...local.webServer as object, env: { SMITHERS_FEATURE_FLAGS_FLOW_LOAD: "true" } }
})
