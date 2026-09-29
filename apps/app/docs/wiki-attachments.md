---
title: "Wiki attachments"
description: "Authenticated Wiki images and downloads in the app."
---

## Images and downloads

Wiki images, inline image embeds, and downloads read their immutable revision
through the selected backend's authenticated application client. Native Plue
uses the configured bearer token; session backends use their existing cookies.
The view receives a temporary browser URL, never a credential in an image or
link URL. Downloads retain the attachment's filename.

Temporary URLs are revoked when their last view closes, the account changes,
or the controller closes. Pending reads are cancelled and late responses are
ignored. An account change does not restart an attachment read. Reads time out
after 30 seconds. Failed or invalidated reads show “Attachment unavailable.” Reopening the attachment
retries the read. Attachment bytes and temporary URLs are not persisted.

The native relay still requires explicit credentials. An unauthenticated or
foreign-origin request cannot borrow the configured token.

## Verification

`bun test src/mainview/WikiAttachmentAuth.test.tsx` from `apps/app` exercises
the rendered Wiki against a TCP native relay and a controlled authenticated
backend. This is transport and rendering evidence, not a packaged native GUI
or deployed-backend acceptance run.
