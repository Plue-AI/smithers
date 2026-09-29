/**
 * The shared consensus conformance contract instantiated for the in-memory
 * single-process strategy — the browser-safe default for tests and local
 * embedding.
 */
import * as Consensus from "../src/Consensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("Consensus.layerLocal", Consensus.layerLocal)
