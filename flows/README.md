# flows

This repository's own project flow directory.

`smthrs flow list` discovers flows by walking `<project>/flows/**` for `flow.ts`,
`flow.mdx`, or `SKILL.md`, parsing frontmatter and module metadata without
importing a module or reading a prompt body. Every directory here is a flow
named by its path, so `flows/create-flow/scaffold/flow.mdx` is the flow
`create-flow/scaffold`. Run state goes to `.flows/`, never here.

## The authoring bodies

`create-flow`, its stages `create-flow/{clarify,provision,design,scaffold,fix,document}`,
and `create-skill/{clarify,design,scaffold,document}` are Markdown flows: the
prompt is the body, and the frontmatter declares the description and the
capabilities the permission kernel grants. `create-flow` is the entry the app's
`/flow.create` door launches; `packages/rpc/src/FlowAuthoring.ts` names it and
its stages.

Capability literals are load-bearing. `proc:spawn:*` grants a command;
`proc:spawn: *`, with a leading space, grants only a command that starts with a
space, and the kernel refuses everything a real body asks for. `pack.test.mjs`
parses every declared literal through the real `Capability.parse` and asserts a
real command line matches.

## Shared notes

`notes/note.ts` retains workspace-confined Markdown reads and atomic writes,
bounded HTTP reads, and date formatting for note authors. Repository wiki and
agent memory remain the maintained sources of truth.

## The 0.x fixture

`migrate-smithers-v1/test/fixtures/smithers-0x-hello/` is the smallest complete
Smithers 0.x project: a JSX workflow, a `.smithers/` pack, agent modules, prompt
bodies, and a `package.json` that scripts 0.x verbs. It is committed test data,
so `fixtures/.gitignore` negates the repository's `.smithers/` rule, and it sits
outside every `pnpm-workspace.yaml` glob so its 0.x dependencies never install.
`pack.test.mjs` runs it through the real migration detector and through the real
CLI, in a copy detached from this repository, so the checks read the fixture and
not the checkout around it.

## Gates

The shared release and wiki model-seat composition in
`release-support/runtime.ts` selects the HTTP adapter at the executable host
boundary. Node owns a replaceable Undici dispatcher; Bun uses Effect's fetch
client through dependency injection and `RequestExecutor.fixed`, because Bun
owns that connection pool. Both transports leave redirects un-followed. The
model, provider routing, authentication and agent actions remain unchanged.
`//flows:provider` runs a real local streaming server through both native
executables, including a rebuild and scope closure; it needs Node and Bun on
the test host. These transport checks do not establish a live provider result.

```sh
node --test flows/pack.test.mjs      # registry, capabilities, detector, real CLI
smithers-build test //flows/...      # the same suite as a build target
```

`packages/smithers/dist` must not exist while these run: `packages/smithers/bin/smithers.mjs`
prefers a build over `src/`, and the real-CLI checks here assert what the source
does.
