// @ts-check
import react from "@astrojs/react"
import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, fontProviders } from "astro/config"
import { fileURLToPath } from "node:url"
import { buildStamp } from "./scripts/build-stamp-integration.ts"
import project from "./src/data/project.json" with { type: "json" }

/**
 * smithers.sh: the landing page at `/` (src/pages/index.astro), the demo
 * request page at `/demo`, the Starlight documentation at `/docs/**` with
 * the release changelogs under `/changelogs/**`, and the product app at
 * `/<owner>/<repo>` for every available catalog repository (src/pages/[owner]/[repo].astro).
 *
 * Starlight content is authored under src/content/docs/docs/ so every route
 * carries the /docs prefix and the root stays a plain Astro page. Add a page
 * there and list it in the sidebar below.
 *
 * The app page mounts apps/app's AppIsland as a `client:only="react"` island,
 * so this build also carries the app's Vite settings: its Tailwind entry
 * (apps/app/src/mainview/index.css) builds through @tailwindcss/vite and stays
 * inside the island's CSS chunk; react, react-dom and effect are deduped so
 * the app and the site share one copy of each; `electrobun/view` resolves to
 * a web shim because no Electrobun SDK exists here; the Vue flags are the
 * ones apps/app/vite.config.ts injects for the Milkdown editor.
 *
 * @since 1.0.0
 * @category configuration
 */
export default defineConfig({
  site: "https://smithers.sh",
  output: "static",
  prefetch: { defaultStrategy: "hover" },
  experimental: { clientPrerender: true },
  // Inter and IBM Plex Mono are the product UI's pairing. Astro downloads them
  // at build time and serves them from /_astro/fonts, so no page waits on a
  // cross-origin Google Fonts stylesheet. Each family names a generic family
  // last, which makes Astro generate a metric-adjusted local fallback; that is
  // what keeps the ASCII wordmark from reflowing when the real face swaps in.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Inter",
      cssVariable: "--font-inter",
      weights: [400, 500, 600, 700],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
      display: "swap"
    },
    {
      provider: fontProviders.google(),
      name: "IBM Plex Mono",
      cssVariable: "--font-plex-mono",
      weights: [400, 500, 600],
      fallbacks: ["ui-monospace", "monospace"],
      display: "swap"
    }
  ],
  vite: {
    server: {
      // Get started for free imports these lazily; a cold dev server otherwise compiles the graph on the first press.
      warmup: { clientFiles: ["../app/src/mainview/ControllerBoot.client.ts", "../app/src/mainview/App.tsx"] },
      /*
       * Dev only: forward the app's API families to a local apps/server
       * (`wrangler dev`). Both timeouts are deliberate. Vite's proxy defaults
       * to none, so a `wrangler dev` that accepts the socket but stops
       * answering — it wedges while it rebuilds — makes /api/bootstrap hang
       * forever, and the app shows a bare wordmark until the 60 s startup
       * watchdog fires. Bounded, the same wedge aborts the request after ten
       * seconds, so the boot rejects and the startup boundary names the failure
       * instead of leaving a blank page.
       */
      proxy: process.env.SMITHERS_DEV_API_ORIGIN
        ? Object.fromEntries(["/api", "/v1", "/workflows"].map((path) => [path, {
          target: process.env.SMITHERS_DEV_API_ORIGIN,
          // An https origin (a deployed backend) needs its own Host and TLS SNI.
          changeOrigin: true,
          ws: true,
          timeout: 10_000,
          proxyTimeout: 10_000
        }]))
        : undefined
    },
    plugins: [tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom", "effect"],
      alias: {
      }
    },
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false"
    },
    build: {
      // Milkdown ships one indivisible 818 kB module behind the World editor's
      // dynamic import; keep the size warning meaningful for every other chunk.
      chunkSizeWarningLimit: 900,
      // The home page's stylesheet is about 7.5 kB, over Vite's 4 kB default;
      // raising the limit lets `build.inlineStylesheets: "auto"` inline it and
      // removes the last render-blocking request on `/`. Fonts never inline:
      // @fontsource's non-latin subsets are under 8 kB each, and as files their
      // unicode-range keeps a Latin visitor from downloading them at all,
      // while inlined they add ~180 kB of base64 to every visitor's app CSS.
      assetsInlineLimit: (filePath, content) => (/\.woff2?$/.test(filePath) ? false : content.byteLength < 8192)
    }
  },
  integrations: [
    react(),
    buildStamp(),
    starlight({
      title: "Smithers",
      routeMiddleware: "./scripts/docs-notice.mjs",
      disable404Route: true,
      description: project.description,
      logo: { src: "./src/docs-assets/logo.png", alt: "Smithers" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/starlight.css", "./src/styles/navigation.css"],
      // Inter and IBM Plex Mono are the product UI's pairing. They come from
      // Google Fonts rather than an npm package so the docs add no dependency,
      // and src/styles/starlight.css names a system stack behind each one.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://smithers.sh/media/og.png" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://smithers.sh/media/og.png" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href:
              "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          }
        }
      ],
      expressiveCode: {
        styleOverrides: {
          codeFontFamily: "\"IBM Plex Mono\", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        }
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/smithersai/smithers" }
      ],
      editLink: { baseUrl: "https://github.com/smithersai/smithers/edit/main/apps/site/src/content/docs/" },
      // M-35: installation is the only public docs entry. Retained reference
      // pages stay off the sidebar while product rules on their destination.
      sidebar: [{ slug: "docs/installation" }, { slug: "docs/reference/http-api" }]
    })
  ]
})
