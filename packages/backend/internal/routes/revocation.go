package routes

import (
	"net/http"
	"sync"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// RevocationSource is what the routes need from the revocation bus: a watch
// for one principal (long-lived handlers) and a subscription for every event
// (registries that own many connections). *revocation.Bus satisfies it.
type RevocationSource interface {
	revocation.Watcher
	Subscribe(fn func(revocation.Event)) func()
}

var (
	revocationMu     sync.RWMutex
	revocationSource RevocationSource
)

// SetRevocationSource installs the process-wide revocation source every
// long-lived handler in this package consults. Call it once at startup before
// serving; a nil source disables revocation-driven termination (streams then
// end only when their own connection does).
func SetRevocationSource(source RevocationSource) {
	revocationMu.Lock()
	defer revocationMu.Unlock()
	revocationSource = source
	relayConns.rearm(source)
}

func currentRevocationSource() RevocationSource {
	revocationMu.RLock()
	defer revocationMu.RUnlock()
	return revocationSource
}

// requestPrincipal describes the caller of r for revocation matching, merged
// with what the handler knows about the resource it serves. The loaded
// repository supplies its organization unless the handler already named one,
// so organization-member removals match repository streams and sessions.
func requestPrincipal(r *http.Request, extra revocation.Principal) revocation.Principal {
	principal := extra
	if authInfo := middleware.AuthInfoFromContext(r.Context()); authInfo != nil {
		if authInfo.User != nil && principal.UserID == 0 {
			principal.UserID = authInfo.User.ID
		}
		if authInfo.IsTokenAuth {
			principal.TokenHash = authInfo.TokenHash
		}
		principal.BrowserSessionHash = authInfo.SessionHash
	} else if user := middleware.UserFromContext(r.Context()); user != nil && principal.UserID == 0 {
		principal.UserID = user.ID
	}
	if principal.OrganizationID == 0 {
		if repo := middleware.RepoFromContext(r.Context()); repo != nil && repo.OrgID.Valid {
			principal.OrganizationID = repo.OrgID.Int64
		}
	}
	return principal
}

// attachRevocation wires an SSE stream to the revocation source so the stream
// ends with a "revoked" event when its principal loses authorization.
func attachRevocation(cfg *sse.BrokerStreamConfig, r *http.Request, extra revocation.Principal) {
	source := currentRevocationSource()
	if source == nil {
		return
	}
	if extra.UserID == 0 {
		extra.UserID = cfg.UserID
	}
	cfg.Revocations = source
	cfg.Principal = requestPrincipal(r, extra)
}
