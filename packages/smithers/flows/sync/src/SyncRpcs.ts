/**
 * Schema-backed RPC projection of the sync read path.
 *
 * @since 0.1.0
 */

import { Rpc, RpcGroup, RpcMiddleware } from "effect/unstable/rpc"
import { SyncError } from "./SyncError.ts"
import { Frame, ReadRequest, ReadResponse, Snapshot, SnapshotRequest, SubscribeRequest } from "./SyncProtocol.ts"

/**
 * Authentication boundary for the sync RPC group.
 *
 * The middleware authenticates each request to a `SyncPrincipal` before the
 * handler runs. The production implementation is `SyncAuth.layer`, which
 * verifies the workspace capability presented in the request headers and
 * installs the resulting principal; a request without a credential runs as
 * the anonymous principal, which the server refuses for every non-branch
 * read.
 *
 * @category middleware
 * @since 0.1.0
 */
export class SyncAuth extends RpcMiddleware.Service<SyncAuth>()("@smthrs/sync/SyncAuth", { error: SyncError }) {}

/**
 * The remote procedures of the sync read path.
 *
 * A subscription's `credit` is a hard frame limit. Clients reconnect with
 * their materialized cursor to replenish it; there is no separate
 * acknowledgement channel.
 *
 * @category groups
 * @since 0.1.0
 */
export const SyncRpcs = RpcGroup.make(
  Rpc.make("Sync.Snapshot", { payload: SnapshotRequest, success: Snapshot, error: SyncError }),
  Rpc.make("Sync.Read", { payload: ReadRequest, success: ReadResponse, error: SyncError }),
  Rpc.make("Sync.Subscribe", { payload: SubscribeRequest, success: Frame, error: SyncError, stream: true })
).middleware(SyncAuth)
