import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.SMITHERS_FAKE_NODE_LOG,
  JSON.stringify({
    cwd: process.cwd(),
    args: process.argv.slice(2),
    oidc: [process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, process.env.ACTIONS_ID_TOKEN_REQUEST_URL].filter(Boolean),
  }),
  "utf8",
);
