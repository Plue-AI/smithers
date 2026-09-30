/**
 * The assembled workspace gateway: one HTTP surface carrying the control
 * plane, the sync read path, the served projections, and a health probe.
 *
 * The package also declares the wire schemas those mounts speak and the pure
 * folds that compute every served row from control-plane facts.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0 @category errors
 */
export * as GatewayError from "./GatewayError.ts"

/**
 * @since 0.1.0 @category models
 */
export * as GatewaySchema from "./GatewaySchema.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as Diagnosis from "./Diagnosis.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as RunTrace from "./RunTrace.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as EngineTrace from "./EngineTrace.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as RunDevTools from "./RunDevTools.ts"

/**
 * @since 1.0.0 @category projections
 */
export * as GatewayProjection from "./GatewayProjection.ts"

/**
 * @since 1.0.0 @category rpc
 */
export * as GatewayRpcs from "./GatewayRpcs.ts"

/**
 * @since 1.0.0 @category layers
 */
export * as GatewayServer from "./GatewayServer.ts"

/**
 * @since 1.0.0 @category services
 */
export * as Projections from "./Projections.ts"

/**
 * @since 1.0.0 @category rpc
 */
export * as RunHistory from "./RunHistory.ts"

/**
 * @since 1.0.0 @category runtime bridge
 */
export * as RuntimeBridge from "./RuntimeBridge.ts"

/**
 * The canonical durable journal synchronization package.
 *
 * @since 0.1.0
 * @category services
 */
export * as Sync from "@smthrs/sync"
