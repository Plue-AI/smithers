import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { createServer, type AddressInfo, type Server } from "node:net"
import { connect, descendants, exchange, listenerReport, listeners, loopbackOnly, parseListeners, processTree } from "./listeners"

const listening = (server: Server, address = "127.0.0.1"): Promise<number> =>
  new Promise(resolve => server.listen(0, address, () => resolve((server.address() as AddressInfo).port)))
const closed = (server: Server): Promise<void> => new Promise(resolve => server.close(() => resolve()))

describe("lsof field output", () => {
  test("names each listener's process, address and port, for IPv4, IPv6 and every-interface sockets", () => {
    expect(parseListeners("p812\ncsmithers-backend\nf9\nn127.0.0.1:4000\nf11\nn*:4000\nf12\nn127.0.0.1:2222\np813\ncpostgres\nf7\nn[::1]:5432\nf8\nn127.0.0.1:5432\n")).toEqual([
      { command: "smithers-backend", pid: 812, address: "127.0.0.1", port: 4000 },
      { command: "smithers-backend", pid: 812, address: "*", port: 4000 },
      { command: "smithers-backend", pid: 812, address: "127.0.0.1", port: 2222 },
      { command: "postgres", pid: 813, address: "::1", port: 5432 },
      { command: "postgres", pid: 813, address: "127.0.0.1", port: 5432 }
    ])
  })

  test("no output is no listeners, and a socket without a port is refused rather than dropped", () => {
    expect(parseListeners("")).toEqual([])
    expect(() => parseListeners("p812\ncsmithers-backend\nnlocalhost\n")).toThrow("Unreadable lsof listener")
    expect(() => parseListeners("n127.0.0.1:4000\n")).toThrow("Unreadable lsof listener")
  })

  test("only 127.0.0.0/8 and ::1 are loopback-only", () => {
    const at = (address: string) => loopbackOnly({ command: "backend", pid: 1, address, port: 4000 })
    expect(["127.0.0.1", "127.8.9.10", "::1"].map(at)).toEqual([true, true, true])
    expect(["*", "0.0.0.0", "10.0.0.22", "::", "fe80::1", "1127.0.0.1"].map(at)).toEqual([false, false, false, false, false, false])
  })
})

describe("the process tree", () => {
  test("is the root and everything below it, never a sibling or the parent", () => {
    const table = "  100     1\n  200   100\n  201   100\n  300   200\n  400     1\n  401   400\n"
    expect(descendants(100, table)).toEqual([100, 200, 201, 300])
    expect(descendants(400, table)).toEqual([400, 401])
    expect(descendants(999, table)).toEqual([999])
  })

  test("of this process holds this process and a child, and neither its parent nor the ps that read it", async () => {
    const child = Bun.spawn(["/bin/sleep", "30"])
    try {
      const tree = processTree(process.pid)
      expect(tree).toContain(process.pid)
      expect(tree).toContain(child.pid)
      expect(tree).not.toContain(process.ppid)
      // Every process in the tree is still running: the short-lived ps is not among them.
      for (const pid of tree) expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      child.kill()
      await child.exited
    }
  })
})

describe("this process's sockets", () => {
  test("a loopback listener is listed at its address and port, and gone once closed", async () => {
    const server = createServer()
    const port = await listening(server)
    try {
      const found = listeners([process.pid]).filter(listener => listener.port === port)
      expect(found).toEqual([{ command: expect.any(String), pid: process.pid, address: "127.0.0.1", port }])
      expect(found.every(loopbackOnly)).toBe(true)
      expect(listenerReport([process.pid])).toContain(`127.0.0.1:${port} (LISTEN)`)
    } finally {
      await closed(server)
    }
    expect(listeners([process.pid]).filter(listener => listener.port === port)).toEqual([])
  })

  test("an every-interface listener is not loopback-only", async () => {
    const server = createServer()
    const port = await listening(server, "0.0.0.0")
    try {
      const found = listeners([process.pid]).filter(listener => listener.port === port)
      expect(found.map(listener => listener.address)).toEqual(["*"])
      expect(found.some(loopbackOnly)).toBe(false)
    } finally {
      await closed(server)
    }
  })

  test("a process that exited, or that listens on nothing, does not hide the others", async () => {
    const exited = spawnSync("/usr/bin/true").pid
    const server = createServer()
    const port = await listening(server)
    try {
      expect(listeners([exited, process.pid, process.ppid]).filter(listener => listener.pid === process.pid && listener.port === port))
        .toEqual([{ command: expect.any(String), pid: process.pid, address: "127.0.0.1", port }])
      expect(listenerReport([exited, process.pid])).toContain(`127.0.0.1:${port} (LISTEN)`)
    } finally {
      await closed(server)
    }
    expect(listeners([exited])).toEqual([])
  })

  test("process ids are required", () => {
    expect(() => listeners([])).toThrow("Listener probe needs process ids")
    expect(() => listeners([0])).toThrow("Listener probe needs process ids")
  })
})

describe("a connection", () => {
  test("to a listener connects and carries the server's first words", async () => {
    const quiet = createServer()
    const ssh = createServer(socket => { socket.write("SSH-2.0-probe\r\n") })
    const [quietPort, sshPort] = [await listening(quiet), await listening(ssh)]
    try {
      expect(await connect("127.0.0.1", quietPort, { banner: 50 })).toEqual({ outcome: "connected", banner: "" })
      expect(await connect("127.0.0.1", sshPort)).toEqual({ outcome: "connected", banner: "SSH-2.0-probe\r\n" })
    } finally {
      await Promise.all([closed(quiet), closed(ssh)])
    }
  })

  test("to an address with no listener is refused", async () => {
    const server = createServer()
    const port = await listening(server)
    await closed(server)
    expect(await connect("127.0.0.1", port)).toEqual({ outcome: "refused" })
  })
})

describe("an exchange", () => {
  test("sends exactly the Host and headers it names and returns the answer", async () => {
    const server = createHttpServer((incoming, outgoing) => {
      let body = ""
      incoming.on("data", chunk => { body += chunk })
      incoming.on("end", () => {
        outgoing.writeHead(421, { "Content-Type": "application/json", "Set-Cookie": ["a=1", "b=2"] })
        outgoing.end(JSON.stringify({ method: incoming.method, url: incoming.url, host: incoming.headers.host, origin: incoming.headers.origin ?? null, body }))
      })
    })
    const port = await listening(server)
    try {
      const answer = await exchange("127.0.0.1", port, { host: "evil.example", method: "POST", path: "/api/install?x=1", headers: { Origin: "http://evil.example" }, body: "{}" })
      expect(answer.status).toBe(421)
      expect(answer.headers["set-cookie"]).toEqual(["a=1", "b=2"])
      expect(JSON.parse(answer.body)).toEqual({ method: "POST", url: "/api/install?x=1", host: "evil.example", origin: "http://evil.example", body: "{}" })
      expect(JSON.parse((await exchange("127.0.0.1", port, { host: "localhost:4000" })).body)).toEqual({ method: "GET", url: "/", host: "localhost:4000", origin: null, body: "" })
    } finally {
      await closed(server)
    }
  })

  test("to an address with no listener rejects", async () => {
    const server = createServer()
    const port = await listening(server)
    await closed(server)
    await expect(exchange("127.0.0.1", port, { host: "localhost" })).rejects.toThrow("ECONNREFUSED")
  })
})
