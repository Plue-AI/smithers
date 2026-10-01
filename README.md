<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->

<pre align="center">
███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗
██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝
███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗
╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║
███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║
╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝
</pre>

<p align="center"><strong>Automate maintaining your codebase</strong></p>

Smithers maintains your codebase. It turns issues into reviewed, tested changes and, when enabled, keeps the project wiki current. Flows beside your code define how.

## Open Smithers

Open [the Smithers repository](https://smithers.sh/smithersai/smithers) in your browser.
Explore its files, ask for work in chat, and inspect runs and changes in the conversation.
Sign in with GitHub when you are ready to contribute. See
[Pricing](https://smithers.sh/docs/pricing/) for Free and Pro plans and deployment
availability. Follow the [app quickstart](https://smithers.sh/docs/quickstart/).

For local execution and authoring, use the CLI and libraries described below.

## Supported platforms

The release candidate's required platform is Linux with Node 26.4.0. See the [support matrix](https://smithers.sh/docs/reference/support-matrix/).

## Install

The 1.0 release candidate is not on npm. Install it from the source checkout
([Installation](https://smithers.sh/docs/installation/#install-the-cli)):

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
export PATH="$PWD/node_modules/.bin:$PATH"
```

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its `model:` field requires.
The [CLI quickstart](https://smithers.sh/docs/cli-quickstart/) covers each step.

```bash
smthrs init change
smthrs flow start change
```

> [!TIP]
> Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.

## Documentation

Read the [Smithers documentation](https://smithers.sh/docs/) for tutorials, guides, and the full reference. For the top-level build API, keep the [Smithers API cheat sheet](./packages/smithers/build/targets/docs/reference/cheat-sheet.md) handy: one file of TypeScript examples covering the whole `Smithers.*` surface.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, testing, and pull request guidance.

## License

Smithers is MIT licensed. See [LICENSE](./LICENSE) for details.

## Join our community

Join the [Smithers community on Telegram](https://t.me/+ANThR9bHDLAwMjUx).
