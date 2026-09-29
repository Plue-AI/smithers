/**
 * The runtime that executes `@smthrs/flow` flows.
 *
 * `FlowEngine` implements `FlowRuntime`, the port `@smthrs/flow` declares, on
 * top of a low-level `Encoded` seam that a store implements. This package
 * ships the volatile in-memory implementation of that seam; `@smthrs/engine-store`
 * supplies the durable one. `FlowProxy` derives RPC and HTTP definitions from
 * flow declarations, and `FlowProxyServer` binds those definitions to a
 * running engine.
 *
 * @since 0.1.0
 */

/**
 * Flow execution services.
 *
 * @since 0.1.0
 */
export * as FlowEngine from "./FlowEngine/index.ts"

/**
 * The injected table that says where a placed flow runs.
 *
 * @since 1.0.0
 */
export * as Hosts from "./Hosts.ts"

/**
 * Client-side flow proxies.
 *
 * @since 0.1.0
 */
export * as FlowProxy from "./FlowProxy.ts"

/**
 * Server-side flow proxy handling.
 *
 * @since 0.1.0
 */
export * as FlowProxyServer from "./FlowProxyServer.ts"
