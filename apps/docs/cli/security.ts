/**
 * `security` reviews the diff against origin/main; `securityAudit` audits
 * every reviewed file. The site is static docs plus its deploy stack, so the
 * checks cover what readers copy and what the deploy publishes.
 *
 * Hand-authored. apps/docs/shared/gen-sites.mjs imports it into the generated
 * PACKAGE.ts as this site's SecurityReview options: `security` reviews the
 * diff against origin/main, `securityAudit` audits every included file.
 */
export const security = {
  include: ["src/**", "public/**", "astro.config.mjs", "alchemy.run.ts", "package.json"],
  checks: [
    {
      id: "no-live-secrets-in-docs",
      title: "Published docs and assets contain no live credential",
      threat: "Any reader of cli.smithers.sh copies a real Smithers, Anthropic, OpenAI, or Cloudflare token and spends the owner's quota or reaches their control plane.",
      lookFor: [
        "A value assigned to SMITHERS_TOKEN, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, OPENROUTER_API_KEY, or CEREBRAS_API_KEY that is not an obvious placeholder.",
        "A string shaped like sk-, sk-ant-, ghp_, github_pat_, or a JWT in a code block or sample output.",
        "A transcript that prints a bearer token, cookie, or signed URL instead of the [REDACTED_TOKEN] form."
      ],
      paths: ["src/content/docs/**", "public/**"]
    },
    {
      id: "safe-copyable-commands",
      title: "Copyable commands keep the gateway authenticated and credentials off argv",
      threat: "A user who pastes a documented command exposes an unauthenticated control gateway on the network or leaks a token into shell history and process listings.",
      lookFor: [
        "A `smthrs serve --host 0.0.0.0 --listen` example without SMITHERS_TOKEN exported first.",
        "A command that passes a token or secret as a flag value or inline in a URL instead of --secret-env, --secret-file, or an exported variable.",
        "A `curl ... | sh` install line or an instruction to disable an approval gate, sandbox, or TLS check."
      ],
      paths: ["src/content/docs/guides/**", "src/content/docs/troubleshooting.md", "src/content/docs/quickstart.md", "src/content/docs/installation.md", "src/content/docs/reference/**"]
    },
    {
      id: "security-claims-match-cli",
      title: "Every security guarantee the docs state is one the CLI enforces",
      threat: "An operator trusts a documented refusal or redaction, exposes a gateway or pastes a secret, and loses their control plane or credential because the CLI does not behave as written.",
      lookFor: [
        "A claim that non-loopback `serve` needs both --listen and SMITHERS_TOKEN whose refusal logic in //packages/smithers does not require both.",
        "A claim that `credentials` output contains references only, or that MCP sessions cannot log in or change the destination, contradicted by the command source.",
        "A claim that a token prints as [REDACTED_TOKEN] where the CLI error or log path prints the raw value."
      ],
      paths: ["src/content/docs/**"]
    },
    {
      id: "deploy-stack-pinned",
      title: "The deploy stack publishes only this site to its own domain",
      threat: "A change to the slug, stage, or source directory publishes another package's content or overwrites a different docs site on the owner's Cloudflare account.",
      lookFor: [
        "A slug in alchemy.run.ts or astro.config.mjs other than \"cli\", or the two disagreeing.",
        "A sourceDir other than packages/smithers, or a contentDir outside src/content/docs.",
        "A deploy or destroy script that targets a stage other than prod or drops --stage."
      ],
      paths: ["alchemy.run.ts", "astro.config.mjs", "package.json"]
    }
  ]
}
