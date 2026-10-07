# Host tools

Configure `ModelTurnHandlerOptions.installOrigin` with the public install origin when callbacks use a private listener. API forwarding uses its host, including the configured port. Otherwise it uses the callback host. Context stream protocol refusals throw the tagged `ResolveFailed` error.
