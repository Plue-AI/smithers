import { defineConfig } from "astro/config"
/**
 * tui.smithers.sh serves the browser playground. The TUI's user docs live on
 * smithers.sh; every former page redirects there.
 */
export default defineConfig({
  site: "https://tui.smithers.sh",
  redirects: {
    "/installation/": "https://smithers.sh/docs/tui/",
    "/guides/fix-a-bug/": "https://smithers.sh/docs/tui/",
    "/guides/chat/": "https://smithers.sh/docs/learn/chat/",
    "/guides/sessions/": "https://smithers.sh/docs/learn/chat/",
    "/guides/shell/": "https://smithers.sh/docs/learn/chat/",
    "/guides/search/": "https://smithers.sh/docs/learn/search/",
    "/guides/background-work/": "https://smithers.sh/docs/learn/background-work/",
    "/guides/review-changes/": "https://smithers.sh/docs/learn/review-a-change/",
    "/guides/time-travel/": "https://smithers.sh/docs/learn/watch-an-agent/",
    "/guides/models/": "https://smithers.sh/docs/learn/models/",
    "/guides/approvals/": "https://smithers.sh/docs/learn/approvals/",
    "/guides/appearance/": "https://smithers.sh/docs/tui/views/",
    "/guides/estimates/": "https://smithers.sh/docs/tui/views/",
    "/automation/flows/": "https://smithers.sh/docs/learn/run-a-flow/",
    "/automation/agents/": "https://smithers.sh/docs/how-it-works/agents/",
    "/automation/views/": "https://smithers.sh/docs/tui/extend/",
    "/automation/extensions/": "https://smithers.sh/docs/tui/extend/",
    "/automation/monitors/": "https://smithers.sh/docs/tui/extend/",
    "/reference/commands/": "https://smithers.sh/docs/tui/commands/",
    "/reference/keys/": "https://smithers.sh/docs/tui/keys/",
    "/reference/cli/": "https://smithers.sh/docs/tui/cli/",
    "/reference/configuration/": "https://smithers.sh/docs/tui/configuration/",
    "/reference/troubleshooting/": "https://smithers.sh/docs/learn/troubleshooting/",
    "/reference/recordings/": "https://github.com/smithersai/smithers/blob/main/apps/tui/docs/README.md"
  },
  // Serve only this app, the workspace packages it imports, and installed dependencies; never the whole checkout.
  vite: {
    server: { fs: { allow: [".", "../../packages/smithers", "../../node_modules"] } },
    optimizeDeps: { exclude: ["@smthrs/agent", "@smthrs/harness"] }
  }
})
