import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { connect } from "node:net"
const nonce = process.env.SMITHERS_CANARY_NONCE
const port = Number(process.env.SMITHERS_CANARY_PORT)
if (!nonce || !/^[a-zA-Z0-9-]+$/.test(nonce) || !Number.isInteger(port) || port < 1 || port > 65535 || !process.env.HOME) throw new Error("canary configuration missing")
const directory = join(process.env.HOME, ".smithers-canary")
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, nonce), nonce)
const socket = connect({ host: "127.0.0.1", port })
socket.on("error", () => {})
socket.on("connect", () => socket.end(nonce))
socket.setTimeout(250, () => socket.destroy())
