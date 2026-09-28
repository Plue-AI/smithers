/*
 * What `electrobun/view` resolves to in a build that has no Electrobun SDK:
 * the smithers.sh site aliases the specifier here (apps/site/astro.config.mjs).
 * NativeBridge.ts reaches `Electroview` only when the native bridge is
 * loaded, which a web host never does, so the bundler drops this module;
 * should a host ever reach it, it throws instead of pretending to be a shell.
 * The Vite build in this package keeps the Hutch devkit alias and never sees
 * this file.
 */
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"

type RequestProxy<Requests> = {
  [Name in keyof Requests]: Requests[Name] extends { params: infer Params; response: infer Response }
    ? (params: Params) => Promise<Response>
    : never
}

type NativeRPC<Schema extends SmithersNativeRPC> = {
  proxy: { request: RequestProxy<Schema["bun"]["requests"]> }
}

export class Electroview<Schema extends SmithersNativeRPC = SmithersNativeRPC> {
  static defineRPC<Schema extends SmithersNativeRPC = SmithersNativeRPC>(
    _options?: { handlers: Schema["webview"] }
  ): NativeRPC<Schema> {
    throw new Error("web build")
  }
  constructor(_options?: { rpc: NativeRPC<Schema> }) {
    throw new Error("web build")
  }
}
