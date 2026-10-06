---
title: "Quickstart"
summary: "Set up the install, merge your first TODO and invite your team."
---

## Install and setup

Use the [install page](https://smithers.sh/docs/installation/) on an Apple Silicon Mac with macOS 15 or later and Homebrew. Prepare a GitHub repository whose default branch is `main`, with squash merging enabled, a coding-model provider key or ChatGPT sign-in, and an AI Gateway key.

Install and start the host on the Mac:

```sh
brew install smithersai/tap/smithers
smthrs host start
smthrs host status
```

For LAN access, replace the hostname with your Mac’s LAN hostname:

```sh
smthrs host start --bind 0.0.0.0 --origin http://studio-mini.local:4000
```

Open the one-time setup URL printed on the Mac. Use the localhost URL on that Mac or the configured network URL from a LAN laptop. Keep the token private. Setup resumes completed steps after a restart; use the newly printed URL if the old token has expired.

Complete the setup card in order:

1. **Address:** choose This Mac or the address your team will open.
2. **GitHub App:** create the App through GitHub. Register the chosen address's callback before signing in.
3. **Owner sign-in:** sign in through the new App. This claims the install and invalidates the setup token.
4. **Repository:** choose the repository and install the App on it. Enable squash merging and use `main` as the default branch on GitHub, then Retry if either check fails.
5. **Model access:** set coding access, the optional fast-model key and the AI Gateway key for Decisions. Without a fast-model key, the app agent uses the coding model.
6. **Source ready:** ask questions once the repository has arrived.
7. **Machine ready:** wait for this separately before starting coding work.

## Open the command list

Open Chat with Command-K on macOS or Control-K on Windows and Linux. Type `/help` and press Enter to list commands. `/docs` opens these pages.

## First TODO to Merged

Ask a question about the repository. Open the answer's file cards to check the sources.

Open `/todo.new`, write one small change and choose **Append**. Watch it move through Queued, Starting, Working and In review. Answer a Needs you question on the branch; use Steer for an additional instruction.

Open the TODO's evidence and pull request. Read the diff, verification results, GitHub checks and review. When the reviewed revision is ready, choose **Merge** in the app and confirm it. People merge; agents cannot approve or merge. The TODO becomes Merged after GitHub reports the squash merge. A learning run follows.

## Members and secrets

Open `/members` and add teammates by GitHub username. They need write access or higher on the repository. Maintainers can manage people and merge; Members can work on branches. The owner cannot be removed or demoted. Teammates open the address set during setup and sign in with GitHub.

Open the Secrets card to set the values your checks need. Choose all branches or main only for each secret. Keep credentials out of prompts, flow source and committed files.

## Connect an editor

On a branch, use its SSH connection details. Replace the branch and install host below:

```sh
ssh -p 2222 <branch>@<install-host>
```

Add your public SSH key through the member controls. Edits share the branch's working copy with the app, terminals and coding agent. A branch terminal is already signed in to Smithers as you and includes the Smithers skill.

## Sign in from a laptop

Install the CLI on your laptop, then sign in to your install address:

```sh
smthrs login --hostname https://smithers.example.com
```

Complete browser sign-in. Your laptop agent uses a delegated credential attributed to you; it cannot approve, merge or move `main`.

## Put HTTPS in front

Plain HTTP works on a LAN. An HTTP origin sends the session cookie unencrypted. Use HTTPS for remote access and browser notifications.

In Settings, the owner sets the bind address and public origins. Loopback is the default. Add the HTTPS origin and its exact GitHub App callback URL, `<origin>/api/auth/github/callback`, before signing in through that address.

For Tailscale serve on the install's Mac:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4000
tailscale serve --bg --tcp=2222 tcp://127.0.0.1:2222
```

Use the HTTPS address it prints as a public origin. The HTTP proxy passes the original host as `X-Forwarded-Host` over loopback; the install accepts that header only from loopback. The TCP listener carries SSH separately.

Or use Caddy on the same Mac, with your DNS name pointing to it:

```caddyfile
smithers.example.com {
    reverse_proxy 127.0.0.1:4000 {
        header_up Host {http.request.host}
        header_up X-Forwarded-Host {http.request.host}
    }
}
```

Set `https://smithers.example.com` as a public origin. A proxy on another host must pass the original `Host` header; forwarding headers from that host are not trusted. Allow access only from your team.

## Restart and recovery

The install runs as a per-user launchd agent. If Hypervisor.framework refuses a daemon, use the LaunchAgent under the installing user's login session. Enable macOS automatic login for that user if the install must return after a reboot without someone logging in. Confirm Machine ready after restarting.

Before restoring a backup on another Mac, stop the original install first:

```sh
smthrs host stop
```

Two running installs would both act on the same repository. Keep backup directories private: they contain the install key and member data. Restore requires a stopped install, verified backup hashes and a compatible installed version. Interrupted work resumes or offers Retry after recovery.

## API and flows

The [HTTP API reference](https://smithers.sh/docs/reference/http-api/) documents the API used by the app and CLI. See [Flows reference](flows.md#change-a-flow) to customize how TODOs run.

## Open the wiki in Obsidian

In Settings, set **Obsidian folder** to an existing folder on the install's Mac, using its absolute path (for example `/Users/will/Vault`). Open that folder as a vault in Obsidian. Wiki edits and folder edits sync both ways every minute; the folder must be owned by the install user and outside the install's state directory. Teammates use the wiki in the app.
