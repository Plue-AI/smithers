package chat

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// SourceReadPath is the producer callback a turn's model host reads its
// repository through. The producer capability names the turn, and the read
// runs as the credential that admitted it.
const SourceReadPath = "/internal/chat/source/read"

// SourceReader serves app-agent reads of a repository's mirrored main for the
// credential that admitted a turn, resolved again at each call. The
// single-owner install composes it; a deployment without one offers the
// model no source and refuses the callback.
type SourceReader interface {
	// Source names the repository the turn may read, or refuses with
	// ports.ErrSourceNotReady or ports.ErrSourceForbidden.
	Source(ctx context.Context, credential middleware.Credential, userID, repositoryID int64) (string, error)
	ReadSource(ctx context.Context, credential middleware.Credential, userID, repositoryID int64, path string) (ports.SourceFile, error)
}

// turnCredentialLifetime bounds how long a turn reads as the credential that
// admitted it: a turn credential's lifetime (spec §5.3, T-ACC-04).
const turnCredentialLifetime = time.Hour

// turnKey is a turn's public identity, known before admission assigns its id.
type turnKey struct {
	userID       int64
	runID, legID string
}

type admittedCredential struct {
	credential middleware.Credential
	at         time.Time
}

// turnCredentials keeps, for each turn this process admitted, the credential
// that admitted it. A host-owned turn reads source only as that credential,
// so its reads carry the admitting request's authority, and end when the
// credential is revoked, expires or loses a scope. A turn this process did not
// admit, such as one recovered after a restart, reads nothing.
type turnCredentials struct {
	mu       sync.Mutex
	now      func() time.Time
	admitted map[turnKey]admittedCredential
}

func newTurnCredentials() *turnCredentials {
	return &turnCredentials{now: time.Now, admitted: map[turnKey]admittedCredential{}}
}

// admit records the credential admitting a turn unless one is recorded.
// release undoes this call's record, for an admission that did not accept.
func (c *turnCredentials) admit(key turnKey, credential middleware.Credential) (release func()) {
	if c == nil || credential == (middleware.Credential{}) {
		return func() {}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for admittedKey, admitted := range c.admitted {
		if now.Sub(admitted.at) >= turnCredentialLifetime {
			delete(c.admitted, admittedKey)
		}
	}
	if _, exists := c.admitted[key]; exists {
		return func() {}
	}
	recorded := admittedCredential{credential: credential, at: now}
	c.admitted[key] = recorded
	return func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if current, ok := c.admitted[key]; ok && current == recorded {
			delete(c.admitted, key)
		}
	}
}

// credential is the credential that admitted a turn, while it may still act.
func (c *turnCredentials) credential(key turnKey) (middleware.Credential, bool) {
	if c == nil {
		return middleware.Credential{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	admitted, ok := c.admitted[key]
	if !ok || c.now().Sub(admitted.at) >= turnCredentialLifetime {
		return middleware.Credential{}, false
	}
	return admitted.credential, true
}

// end forgets a finished turn's credential.
func (c *turnCredentials) end(key turnKey) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.admitted, key)
}

type sourceReadRequest struct {
	TurnID     string `json:"turnId"`
	Generation int64  `json:"generation"`
	Path       string `json:"path"`
}

// SourceRead serves one file to a live producer, read as the credential that
// admitted its turn: a fenced, cancelled, expired or finished turn, or one
// whose admitting credential is unknown here, reads nothing.
func (h *Handler) SourceRead(w http.ResponseWriter, r *http.Request) {
	if h.Store == nil {
		writeProblem(w, http.StatusServiceUnavailable, "storage_failed")
		return
	}
	var request sourceReadRequest
	if !decodeBounded(w, r, &request) {
		return
	}
	turn, ok := h.liveProducer(w, r, request.TurnID, request.Generation)
	if !ok {
		return
	}
	if h.Sources == nil {
		writeProblem(w, http.StatusServiceUnavailable, "source_unavailable")
		return
	}
	credential, ok := h.admittingCredential(w, turn)
	if !ok {
		return
	}
	file, err := h.Sources.ReadSource(r.Context(), credential, turn.UserID, turn.RepositoryID, request.Path)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, file)
	case errors.Is(err, ports.ErrSourceNotReady):
		writeProblem(w, http.StatusConflict, "source_not_ready")
	case errors.Is(err, ports.ErrSourcePathRefused):
		writeProblem(w, http.StatusBadRequest, "path_refused")
	case errors.Is(err, ports.ErrSourceForbidden):
		writeProblem(w, http.StatusForbidden, "forbidden")
	case errors.Is(err, ports.ErrSourceNotFound):
		writeProblem(w, http.StatusNotFound, "not_found")
	case errors.Is(err, ports.ErrSourceTooLarge):
		writeProblem(w, http.StatusRequestEntityTooLarge, "too_large")
	default:
		logger := h.logger
		if logger == nil {
			logger = slog.Default()
		}
		logger.Error("chat source read failed", "turn_id", request.TurnID, "error", err)
		writeProblem(w, http.StatusServiceUnavailable, "source_failed")
	}
}
