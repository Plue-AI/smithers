import { WORKER_IDENTITY } from "../../src/workerIdentity"

/** The fixed one-time inventory target: the web Worker's retained namespaces, never an arbitrary Worker or namespace. */
export const target = { kind: "web", name: WORKER_IDENTITY.name, domain: WORKER_IDENTITY.domain.name, durableObjects: WORKER_IDENTITY.durableObjects } as const
