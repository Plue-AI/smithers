// Independent literal oracle: mvp.md Appendix A (57 catalog rows).
export const appendixExpectations = [
  [
    "⌘K (no slash)",
    "Ask or tell Smithers anything"
  ],
  [
    "/help",
    "List these commands"
  ],
  [
    "/docs",
    "Read the docs in the app"
  ],
  [
    "/stop",
    "Stop the current answer"
  ],
  [
    "/search",
    "Search code, wiki and runs"
  ],
  [
    "/stack",
    "Show the stack and background runs"
  ],
  [
    "/todo.new",
    "Write and place a TODO"
  ],
  [
    "/todo.from-issue #n",
    "Draft a TODO from an issue"
  ],
  [
    "/todo T12",
    "Open a TODO's card"
  ],
  [
    "/todo.answer T12",
    "Answer the agent's question"
  ],
  [
    "/todo.steer T12",
    "Send the agent a correction"
  ],
  [
    "/todo.amend T12",
    "Change an unmerged TODO's prompt"
  ],
  [
    "/todo.stop T12",
    "Pause a working TODO"
  ],
  [
    "/todo.resume T12",
    "Resume a paused TODO"
  ],
  [
    "/todo.retry T12",
    "Retry a failed TODO"
  ],
  [
    "/todo.drop T12",
    "Abandon an unmerged TODO"
  ],
  [
    "/stack.move T12 up|down",
    "Reorder an item"
  ],
  [
    "/merge T12",
    "Review and merge the next item"
  ],
  [
    "/branches",
    "List branches with presence"
  ],
  [
    "/branch <name|T12>",
    "Open a branch's card"
  ],
  [
    "/branch.fork",
    "Fork a scratch branch"
  ],
  [
    "/branch.add-to-stack",
    "Add a scratch branch as a TODO"
  ],
  [
    "/branch.rebase",
    "Rebase this branch now"
  ],
  [
    "/terminal",
    "Open a terminal on a branch"
  ],
  [
    "/file <path>",
    "Open and co-edit a file"
  ],
  [
    "/files",
    "Browse a branch's files"
  ],
  [
    "/diff",
    "Show a branch's changes"
  ],
  [
    "/review",
    "Review a change, return findings"
  ],
  [
    "/pr #n",
    "Open a pull request's card"
  ],
  [
    "/issues",
    "List the repository's issues"
  ],
  [
    "/issue #n",
    "Open an issue's card"
  ],
  [
    "/issue.new",
    "Open a GitHub issue"
  ],
  [
    "/issue.comment #n",
    "Comment on an issue"
  ],
  [
    "/wiki",
    "Open the wiki"
  ],
  [
    "/wiki.page <name>",
    "Open or create a page"
  ],
  [
    "/wiki.save",
    "Save this answer as a page"
  ],
  [
    "/flows",
    "List the repository's flows"
  ],
  [
    "/flow <name>",
    "Show a flow's steps and versions"
  ],
  [
    "/flow.edit <name>",
    "Propose a change to a flow"
  ],
  [
    "/flow.run <name>",
    "Run a flow with typed input"
  ],
  [
    "/flow.new",
    "Create a new flow"
  ],
  [
    "/runs",
    "Active and attention-needing runs"
  ],
  [
    "/run <id>",
    "Open a run's card"
  ],
  [
    "/github",
    "Show sync status and retry"
  ],
  [
    "/monitor",
    "Every run, with its debug view"
  ],
  [
    "/debug-api",
    "Try any call in the open API"
  ],
  [
    "/run.inspect <id>",
    "Open a run's monitor"
  ],
  [
    "/flow.source <name>",
    "Co-edit a flow's source"
  ],
  [
    "/flow.plan <name>",
    "Preview a flow's plan"
  ],
  [
    "/agents",
    "The factory's agents"
  ],
  [
    "/agent <name>",
    "Configure an agent"
  ],
  [
    "/settings",
    "Model access, machines, GitHub (owner)"
  ],
  [
    "/secrets",
    "Set secrets machines can use"
  ],
  [
    "/members",
    "Add people and manage roles"
  ],
  [
    "/ssh <branch>",
    "Copy the SSH line for a branch"
  ],
  [
    "/sign-in, /sign-out",
    "Sign in with GitHub"
  ],
  [
    "/theme",
    "Switch light or dark"
  ]
] as const
