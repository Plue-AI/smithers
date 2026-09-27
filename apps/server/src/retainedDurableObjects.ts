import { retiredDurable } from "./RetiredDurableObject"

/**
 * Inert storage owners for the legacy state, retained unmigrated under unchanged
 * identities (cutover/activation.json). Keeping each
 * class, binding and migration identity preserves Cloudflare storage for
 * rollback. No request reads or writes product state and no job launches.
 * An alarm still pending at retirement is never acknowledged away: it leaves
 * a marker in the reserved maintenance table and refuses (RetiredDurableObject.ts).
 */
export class TurnCancelRegistry extends retiredDurable("smithers-mvp-web", "TURN_CANCELS") {}
export class GatewaySessionRegistry extends retiredDurable("smithers-mvp-web", "GATEWAY_SESSIONS") {}
export class TurnRateLimiter extends retiredDurable("smithers-mvp-web", "TURN_LIMITS") {}
export class ClientErrorLog extends retiredDurable("smithers-mvp-web", "CLIENT_ERRORS") {}
export class RecommendLog extends retiredDurable("smithers-mvp-web", "RECOMMEND_LOG") {}
export class AccountModelVault extends retiredDurable("smithers-mvp-web", "MODEL_VAULTS") {}
