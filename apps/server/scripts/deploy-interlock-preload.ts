/**
 * Test support for scripts/deploy-interlock.test.ts, loaded with `bun --preload`.
 * Replaces fetch with the fake Cloudflare control plane and makes one crafted
 * version of smithers-mvp-web live, chosen by DEPLOY_INTERLOCK_LIVE. Never
 * imported by the deploy path.
 */
import { FakeCloudflare } from "./fakeCloudflare"
const live = process.env.DEPLOY_INTERLOCK_LIVE
const fake = new FakeCloudflare().install()
const uuid = "2b1f6a1e-7d3c-4e4a-9b9e-0c1d2e3f4a5b"
// A retired cutover-installer fence: no longer a recognized version, so the guard refuses it as unknown.
if (live === "fence") fake.setLive("smithers-mvp-web", "cutover-fence-entry.js", `smithers-cutover ${uuid} fence`, ["cutover-fence-helper.js", "index.js"])
else if (live === "export") fake.setLive("smithers-mvp-web", "sealed-export-entry.js", "temporary sealed inventory over " + "a".repeat(40), ["sealed-export-helper.js", "index.js"])
else if (live === "edge") fake.setLive("smithers-mvp-web", "edge.js", "b".repeat(40) + " edge")
else if (live === "secret-rotated") fake.setLive("smithers-mvp-web", "index.js", null)
else if (live !== "legacy") throw new Error("DEPLOY_INTERLOCK_LIVE must name a live state")
