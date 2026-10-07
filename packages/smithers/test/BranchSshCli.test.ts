import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"

const child = vi.hoisted(() => ({ spawn: vi.fn(() => ({ exited: Promise.resolve(7) })) }))
vi.mock("../src/internal/backend/Process.ts", () => child)
import { makeCli } from "../src/Cli.ts"

describe("branch SSH catalog CLI", () => {
 it.each([
  { branch: "smithers/retry", host: "factory.example", port: 2222 },
  { branch: "scratch/alice/retry", host: "localhost", port: 2222 },
  { branch: "scratch/alice/retry", host: "::1", port: 2222 }
 ])("spawns argv for $host", async endpoint => {
  child.spawn.mockClear()
  const result = await invoke(endpoint)
  expect(result.seen).toEqual(["/api/ssh?branch=retry"])
  expect(child.spawn).toHaveBeenCalledWith("ssh", ["-p", "2222", "-l", endpoint.branch, endpoint.host], expect.objectContaining({ stdio: "inherit" }))
  expect(result.code).toBe(7)
 })
 it.each([
  { branch: "main", host: "localhost", port: 2222 },
  { branch: "retry;touch /tmp/canary", host: "localhost", port: 2222 },
  { branch: "smithers/retry", host: "-oProxyCommand=bad", port: 2222 },
  { branch: "smithers/retry", host: "local host", port: 2222 },
  { branch: "smithers/retry", host: "localhost", port: 22 }
 ])("refuses invalid endpoint %j before spawn", async endpoint => {
  child.spawn.mockClear()
  const result = await invoke(endpoint)
  expect(child.spawn).not.toHaveBeenCalled()
  expect(result.code).toBe(1)
  expect(result.output).toContain("invalid_ssh_endpoint")
 })
})

async function invoke(endpoint: unknown) {
 const home = await mkdtemp(join(tmpdir(), "branch-ssh-cli-"))
 const seen: string[] = []
 const server = createServer((request,response) => {
  seen.push(request.url!)
  response.writeHead(200,{"Content-Type":"application/json"})
  response.end(JSON.stringify(endpoint))
 })
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
 const environment = { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, SMITHERS_TOKEN: "fixture-token", SMITHERS_API_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
 let code=0, output=""
 try {
  await makeCli({environment,exit:value=>{code=value}}).serve(["ssh","retry","--json"],{env:environment,stdout:value=>{output+=value},exit:value=>{code=value}})
  return {code,output,seen}
 } finally {
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  await rm(home,{recursive:true,force:true})
 }
}
