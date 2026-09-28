import { choose } from "./source.ts"
if (choose(true) !== "positive") throw new Error("Wrong source result")
process.on("SIGTERM", () => process.exit(23))
console.log("ready")
setInterval(() => {}, 1_000)
