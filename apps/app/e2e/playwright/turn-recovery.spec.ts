import { test } from "./browserTest"

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "uses the local deterministic model")
