# Review credential boundary

Scan every bounded changed and context file before any review inference. Mask
credential values in both prompt and policy, model answers, findings, and
failure diagnostics with stable typed placeholders. Keep the default review
transport tool-free and preserve the immutable snapshot API.

Reviewer subprocesses use a minimal engine-specific environment, a disposable
HOME and working directory, and no inherited CLI login files. This isolates
configuration; it does not sandbox a trusted executable override.

Rotation delivery is an optional trusted-host callback before inference. Send
only credential names and locations. A failed delivery stops the review with a
generic receipt; durable retry, deduplication and hosted receiver configuration
belong to the host workflow and private deployment repository. A credential
finding is not proof of rotation or delivery.
