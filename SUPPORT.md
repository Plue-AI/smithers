# Support

| You need | Channel | Response target |
| --- | --- | --- |
| Pro account, billing, refund, cancellation or data request | Email [support@smithers.sh](mailto:support@smithers.sh) | 1 business day |
| Bug or feature request | [GitHub issues](https://github.com/smithersai/smithers/issues/new/choose) | 1 business day for Pro accounts; best effort otherwise |
| Security vulnerability | [Private vulnerability report](https://github.com/smithersai/smithers/security/advisories/new), see [SECURITY.md](SECURITY.md) | 1 business day |
| Service status | [status.smithers.sh](https://status.smithers.sh) | — |

Business days are Monday to Friday, US Pacific time, excluding US federal holidays. The response target is a first human reply, not a fix.

Keep private code, credentials and billing details out of public issues; send them by email.

## Delete or export your account data

Email [support@smithers.sh](mailto:support@smithers.sh) from the address on your account and say whether you want your data deleted or a copy of it. The date of that email starts the clock: we finish within 30 days.

An operator exports a copy with:

```sh
smthrs admin user export <username> <username>-export.tar.gz
```

The archive holds your profile and SSH public keys, a git bundle of each repository you own (`git clone <name>.bundle` restores every branch), your issues, comments, landing requests, run history, and `manifest.json` listing every file with its SHA-256. We send it to the address on your account.

An operator deletes the account with:

```sh
smthrs admin user erase <username> --request-date <YYYY-MM-DD> --yes
```

The erase deletes the repositories you own, your workspaces, their sandboxes and saved snapshots, sessions, tokens, SSH keys, provider connections and chat history. It keeps billing, credit and tax records we must keep by law, with your name and email removed. Your comments, issues and releases in other people's repositories stay, attributed to a deleted user. Running it again changes nothing, even after someone else takes your username, and every run is recorded in the audit log with the request date.

Policies: [Terms](https://smithers.sh/terms/) · [Privacy](https://smithers.sh/privacy/) · [Refunds](https://smithers.sh/refunds/)
