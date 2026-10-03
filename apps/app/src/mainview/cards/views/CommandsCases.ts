import type { CommandsCard } from "@smthrs/rpc/CommandsCard"

// Literal presentation input transcribed from mvp.md Appendix A; Appendix B supplies presentation policies; tags are opaque placeholders.
export const appendixCases: CommandsCard = {
  "groups": [
    {
      "label": "Ask",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "⌘K (no slash)",
          "description": "Ask or tell Smithers anything",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/help",
          "description": "List these commands",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/docs",
          "description": "Read the docs in the app",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/stop",
          "description": "Stop the current answer",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/search",
          "description": "Search code, wiki and runs",
          "agent": "run"
        }
      ]
    },
    {
      "label": "TODOs and the stack",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/stack",
          "description": "Show the stack and background runs",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.new",
          "description": "Write and place a TODO",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/todo.from-issue #n",
          "description": "Draft a TODO from an issue",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/todo T12",
          "description": "Open a TODO's card",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.answer T12",
          "description": "Answer the agent's question",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.steer T12",
          "description": "Send the agent a correction",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.amend T12",
          "description": "Change an unmerged TODO's prompt",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/todo.stop T12",
          "description": "Pause a working TODO",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.resume T12",
          "description": "Resume a paused TODO",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.retry T12",
          "description": "Retry a failed TODO",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/todo.drop T12",
          "description": "Abandon an unmerged TODO",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/stack.move T12 up|down",
          "description": "Reorder an item",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/merge T12",
          "description": "Review and merge the next item",
          "agent": "confirm"
        }
      ]
    },
    {
      "label": "Branches and machines",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/branches",
          "description": "List branches with presence",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/branch <name|T12>",
          "description": "Open a branch's card",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/branch.fork",
          "description": "Fork a scratch branch",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/branch.add-to-stack",
          "description": "Add a scratch branch as a TODO",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/branch.rebase",
          "description": "Rebase this branch now",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/terminal",
          "description": "Open a terminal on a branch",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Files and code",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/file <path>",
          "description": "Open and co-edit a file",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/files",
          "description": "Browse a branch's files",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/diff",
          "description": "Show a branch's changes",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Review",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/review",
          "description": "Review a change, return findings",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/pr #n",
          "description": "Open a pull request's card",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Issues",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/issues",
          "description": "List the repository's issues",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/issue #n",
          "description": "Open an issue's card",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/issue.new",
          "description": "Open a GitHub issue",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/issue.comment #n",
          "description": "Comment on an issue",
          "agent": "confirm"
        }
      ]
    },
    {
      "label": "Wiki",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/wiki",
          "description": "Open the wiki",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/wiki.page <name>",
          "description": "Open or create a page",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/wiki.save",
          "description": "Save this answer as a page",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Flows",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/flows",
          "description": "List the repository's flows",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/flow <name>",
          "description": "Show a flow's steps and versions",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/flow.edit <name>",
          "description": "Propose a change to a flow",
          "agent": "confirm"
        },
        {
          "tag": "help",
          "synopsis": "/flow.run <name>",
          "description": "Run a flow with typed input",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/flow.new",
          "description": "Create a new flow",
          "agent": "confirm"
        }
      ]
    },
    {
      "label": "Runs",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/runs",
          "description": "Active and attention-needing runs",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/run <id>",
          "description": "Open a run's card",
          "agent": "run"
        }
      ]
    },
    {
      "label": "GitHub",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/github",
          "description": "Show sync status and retry",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Advanced",
      "advanced": true,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/monitor",
          "description": "Every run, with its debug view",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/debug-api",
          "description": "Try any call in the open API",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/run.inspect <id>",
          "description": "Open a run's monitor",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/flow.source <name>",
          "description": "Co-edit a flow's source",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/flow.plan <name>",
          "description": "Preview a flow's plan",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/agents",
          "description": "The factory's agents",
          "agent": "run"
        },
        {
          "tag": "help",
          "synopsis": "/agent <name>",
          "description": "Configure an agent",
          "agent": "run"
        }
      ]
    },
    {
      "label": "Account and settings",
      "advanced": false,
      "commands": [
        {
          "tag": "help",
          "synopsis": "/settings",
          "description": "Model access, machines, GitHub (owner)",
          "agent": "never"
        },
        {
          "tag": "help",
          "synopsis": "/secrets",
          "description": "Set secrets machines can use",
          "agent": "never"
        },
        {
          "tag": "help",
          "synopsis": "/members",
          "description": "Add people and manage roles",
          "agent": "never"
        },
        {
          "tag": "help",
          "synopsis": "/ssh <branch>",
          "description": "Copy the SSH line for a branch",
          "agent": "never"
        },
        {
          "tag": "help",
          "synopsis": "/sign-in, /sign-out",
          "description": "Sign in with GitHub",
          "agent": "never"
        },
        {
          "tag": "help",
          "synopsis": "/theme",
          "description": "Switch light or dark",
          "agent": "run"
        }
      ]
    }
  ]
}
