package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Preserve context cancellation identity for callers while distinguishing a
// revocation from a disconnected client or a superseded launch.
var errWorkspaceSocketRevoked = fmt.Errorf("access revoked: %w", context.Canceled)

// workspaceSocketRevocation covers admission, startup and attachment with one
// subscription. Bus delivery cancels startup and invalidates resources
// synchronously; transport cleanup runs separately so a slow peer cannot
// block delivery to other consumers.
type workspaceSocketRevocation struct {
	closeOnce        sync.Once
	mu               sync.Mutex
	ctx              context.Context
	cancel           context.CancelFunc
	unsubscribe      func()
	checker          revocation.Checker
	principal        revocation.Principal
	pending          []revocation.Event
	pendingSandboxes map[string]struct{}
	resolved         bool
	overflow         bool
	revoked          bool
	socket           *websocket.Conn
	onRevoked        []func()
}

type workspaceSocketRevocationKey struct{}

// WorkspaceSocketRevocations subscribes before repository authorization loads.
// Authentication runs first; cached credential checks bridge that boundary.
func WorkspaceSocketRevocations(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		guard := watchWorkspaceSocket(r)
		defer guard.close()
		if guard.reject(w) {
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workspaceSocketRevocationKey{}, guard)))
	})
}

func watchWorkspaceSocket(r *http.Request) *workspaceSocketRevocation {
	if guard, ok := r.Context().Value(workspaceSocketRevocationKey{}).(*workspaceSocketRevocation); ok {
		guard.mu.Lock()
		// Keep values added by authorization middleware while extending the
		// same synchronously canceled startup lifetime.
		ctx, cancel := context.WithCancel(r.Context())
		previousCancel := guard.cancel
		guard.ctx = ctx
		guard.cancel = func() { previousCancel(); cancel() }
		if guard.revoked || guard.overflow {
			cancel()
		}
		guard.principal = requestPrincipal(r, guard.principal)
		if repo := middleware.RepoFromContext(r.Context()); repo != nil {
			guard.principal.RepositoryID = repo.ID
		}
		for _, event := range guard.pending {
			if event.Affects(guard.principal) {
				guard.revokeLocked()
			}
		}
		guard.mu.Unlock()
		return guard
	}
	ctx, cancel := context.WithCancel(r.Context())
	principal := requestPrincipal(r, revocation.Principal{})
	if repo := middleware.RepoFromContext(r.Context()); repo != nil {
		principal.RepositoryID = repo.ID
	}
	g := &workspaceSocketRevocation{ctx: ctx, cancel: cancel, principal: principal, unsubscribe: func() {}}
	if source := currentRevocationSource(); source != nil {
		g.unsubscribe = source.Subscribe(func(event revocation.Event) {
			g.mu.Lock()
			defer g.mu.Unlock()
			if event.Affects(g.principal) {
				g.revokeLocked()
			} else if !g.resolved {
				g.rememberLocked(event)
			}
		})
		// Subscribe first: a credential deletion between authentication and
		// registration is cached; one after registration reaches the callback.
		g.checker, _ = source.(revocation.Checker)
		if g.checker != nil && (g.checker.IsTokenRevoked(principal.TokenHash) || g.checker.IsUserDisabled(principal.UserID)) {
			g.mu.Lock()
			g.revokeLocked()
			g.mu.Unlock()
		}
	}
	return g
}

// Only retain principal events which unknown resource IDs could make relevant.
// Sandbox identities are deduplicated separately until the VM ID is known.
func (g *workspaceSocketRevocation) mayMatchScope(event revocation.Event) bool {
	p := g.principal
	switch event.Kind {
	case revocation.KindCollaboratorRemoved:
		return p.RepositoryID == 0 && event.RepositoryID != 0 && event.UserID != 0 && event.UserID == p.UserID
	case revocation.KindOrgMemberRemoved:
		return p.OrganizationID == 0 && event.OrganizationID != 0 && event.UserID != 0 && event.UserID == p.UserID
	case revocation.KindWorkspaceShareRemoved:
		return p.WorkspaceID == "" && event.WorkspaceID != "" && (event.UserID == 0 || event.UserID == p.UserID)
	}
	return false
}

// A repeated burst for one sandbox or grant occupies one slot. Bound distinct
// unresolved identities; cancel admission for a retry if it exceeds that bound.
func (g *workspaceSocketRevocation) rememberLocked(event revocation.Event) {
	if g.principal.SandboxID == "" {
		for _, id := range event.SandboxIDs {
			if !event.Affects(revocation.Principal{SandboxID: id}) {
				continue
			}
			if _, ok := g.pendingSandboxes[id]; ok {
				continue
			}
			if len(g.pending)+len(g.pendingSandboxes) == 64 {
				g.overflow = true
				g.cancel()
				return
			}
			if g.pendingSandboxes == nil {
				g.pendingSandboxes = make(map[string]struct{})
			}
			g.pendingSandboxes[id] = struct{}{}
		}
	}
	if !g.mayMatchScope(event) {
		return
	}
	for _, saved := range g.pending {
		if saved.Kind == event.Kind && saved.UserID == event.UserID && saved.RepositoryID == event.RepositoryID && saved.OrganizationID == event.OrganizationID && saved.WorkspaceID == event.WorkspaceID {
			return
		}
	}
	if len(g.pending)+len(g.pendingSandboxes) == 64 {
		g.overflow = true
		g.cancel()
		return
	}
	event.SandboxIDs = nil
	g.pending = append(g.pending, event)
}

func (g *workspaceSocketRevocation) rejectStartup(w http.ResponseWriter, err error) bool {
	if errors.Is(err, errWorkspaceSocketRevoked) {
		g.mu.Lock()
		g.revokeLocked()
		g.mu.Unlock()
	}
	return g.reject(w)
}

func (g *workspaceSocketRevocation) close() { g.closeOnce.Do(func() { g.unsubscribe(); g.cancel() }) }

func (g *workspaceSocketRevocation) scope(workspaceID, sandboxID string, resolved bool) revocation.Principal {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.principal.WorkspaceID = workspaceID
	g.principal.SandboxID = sandboxID
	if _, revoked := g.pendingSandboxes[sandboxID]; revoked {
		g.revokeLocked()
	}
	for _, event := range g.pending {
		if event.Affects(g.principal) {
			g.revokeLocked()
		}
	}
	g.resolved = resolved
	if resolved {
		g.pending = nil
		g.pendingSandboxes = nil
	}
	return g.principal
}

// onRevoke registers synchronous resource invalidation for access revocation.
// Callbacks must not wait for transport cleanup or peer handshakes. Ordinary
// request cancellation leaves a durable terminal available for reconnect.
func (g *workspaceSocketRevocation) onRevoke(cleanup func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.revoked {
		cleanup()
		return
	}
	g.onRevoked = append(g.onRevoked, cleanup)
}

func (g *workspaceSocketRevocation) revokeLocked() {
	if g.revoked {
		return
	}
	g.revoked = true
	g.cancel()
	for _, cleanup := range g.onRevoked {
		cleanup()
	}
	g.onRevoked = nil
	if g.socket != nil {
		ws := g.socket
		go func() { _ = ws.Close(websocket.StatusPolicyViolation, "access revoked") }()
	}
}

func (g *workspaceSocketRevocation) reject(w http.ResponseWriter) bool {
	g.mu.Lock()
	principal := g.principal
	g.mu.Unlock()
	// Delivery can be waiting behind another subscriber after the bus has
	// cached the event. Recheck at each gate, including immediately before
	// upgrade, rather than depending on callback scheduling.
	cached := g.checker != nil && (g.checker.IsTokenRevoked(principal.TokenHash) || g.checker.IsUserDisabled(principal.UserID))
	g.mu.Lock()
	if cached {
		g.revokeLocked()
	}
	revoked, overflow := g.revoked, g.overflow
	g.mu.Unlock()
	if revoked {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("access revoked"))
	} else if overflow {
		err := pkgerrors.New(pkgerrors.CodeServiceUnavailable, "connection admission busy; retry")
		err.RetryAfter = 1
		pkgerrors.WriteError(w, err)
	}
	return revoked || overflow
}

// bind closes the upgrade race before any relay starts. The same mutex orders
// registration against a concurrent revocation callback.
func (g *workspaceSocketRevocation) bind(ws *websocket.Conn) bool {
	g.mu.Lock()
	g.socket = ws
	revoked := g.revoked
	g.mu.Unlock()
	if revoked {
		_ = ws.Close(websocket.StatusPolicyViolation, "access revoked")
	}
	return !revoked
}
