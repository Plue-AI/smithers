import { fileURLToPath } from "node:url"
import { bundle } from "../coding/build.mjs"

await bundle(fileURLToPath(new URL("./fixtures/rehearsal-coding-host.ts", import.meta.url)), process.argv[2])
