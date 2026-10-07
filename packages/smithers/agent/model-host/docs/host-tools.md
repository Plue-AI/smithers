# Host tools

The backend supplies the current public install origin in each authenticated turn grant. Address changes apply to the next turn. API calls still target the private callback listener and forward the public host, port, and scheme; redirects never receive the credential.

Standalone hosts can override the grant with `ModelTurnHandlerOptions.installOrigin`. Without either value, forwarding uses the callback origin. Wire origins must be HTTP or HTTPS origins without user information, paths, queries, or fragments. Context stream protocol refusals throw the tagged `ResolveFailed` error.
