package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// fakePairSessions is a test double for PairSessionsService. It records the last
// actor/session it was called with and returns a configurable error, so the
// route tests can prove the HTTP layer (a) requires an authenticated user,
// (b) forwards the real signed-in user id as the actor, and (c) maps a service
// authz error (e.g. a viewer hitting an editor-only route) to the right HTTP
// status. The service's own role/plan logic is covered by the service tests;
// these tests prove the wiring that makes that logic reachable over HTTP.
type fakePairSessions struct {
	err           error
	lastActor     int64
	lastID        string
	lastLinkID    string
	lastPromptID  string
	lastSource    string
	lastBody      string
	lastInviteKey string // "email:<v>" or "username:<v>" — proves dispatch
	lastCall      string
	enqueued      db.PairPromptQueue
	resolution    services.PairResolution
}

func (f *fakePairSessions) CreateSession(_ context.Context, ownerID, _ int64, src string) (db.PairSession, error) {
	f.lastActor, f.lastSource = ownerID, src
	if f.err != nil {
		return db.PairSession{}, f.err
	}
	return db.PairSession{ID: "sess-new", OwnerUserID: ownerID, Status: "provisioning"}, nil
}

func (f *fakePairSessions) ResolveSession(_ context.Context, id string, visitor int64) (services.PairResolution, error) {
	f.lastActor, f.lastID = visitor, id
	f.lastCall = "join-session"
	return f.resolution, f.err
}

func (f *fakePairSessions) PreviewSession(_ context.Context, id string, visitor int64) (services.PairResolution, error) {
	f.lastActor, f.lastID = visitor, id
	f.lastCall = "preview-session"
	return f.resolution, f.err
}

func (f *fakePairSessions) ResolveByLink(_ context.Context, slug string, visitor int64) (services.PairResolution, error) {
	f.lastActor, f.lastID = visitor, slug
	f.lastCall = "join-link"
	return f.resolution, f.err
}

func (f *fakePairSessions) PreviewByLink(_ context.Context, slug string, visitor int64) (services.PairResolution, error) {
	f.lastActor, f.lastID = visitor, slug
	f.lastCall = "preview-link"
	return f.resolution, f.err
}

func (f *fakePairSessions) PreviewForSource(_ context.Context, sourceWorkspaceID string, visitor int64) (services.PairResolution, error) {
	f.lastActor, f.lastSource = visitor, sourceWorkspaceID
	f.lastCall = "preview-source"
	return f.resolution, f.err
}

func (f *fakePairSessions) EndSession(_ context.Context, id string, actor int64) error {
	f.lastActor, f.lastID = actor, id
	return f.err
}

func (f *fakePairSessions) ListMembers(_ context.Context, id string, actor int64) ([]db.PairSessionMember, error) {
	f.lastActor, f.lastID = actor, id
	return nil, f.err
}

func (f *fakePairSessions) ListMemberProfiles(_ context.Context, id string, actor int64) ([]db.ListLivePairSessionMemberProfilesRow, error) {
	f.lastActor, f.lastID = actor, id
	return nil, f.err
}

func (f *fakePairSessions) SetMemberRole(_ context.Context, id string, actor, _ int64, _ string) (db.PairSessionMember, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairSessionMember{}, f.err
}

func (f *fakePairSessions) RevokeMember(_ context.Context, id string, actor, _ int64) error {
	f.lastActor, f.lastID = actor, id
	return f.err
}

func (f *fakePairSessions) SetAccessMode(_ context.Context, id string, actor int64, _ string) (db.PairSession, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairSession{}, f.err
}

func (f *fakePairSessions) CreateInvite(_ context.Context, id string, actor int64, email, _ string) (services.InviteResult, error) {
	f.lastActor, f.lastID, f.lastInviteKey = actor, id, "email:"+email
	return services.InviteResult{}, f.err
}

func (f *fakePairSessions) CreateInviteByUsername(_ context.Context, id string, actor int64, username, _ string) (services.InviteResult, error) {
	f.lastActor, f.lastID, f.lastInviteKey = actor, id, "username:"+username
	// A username invite whose row somehow carries an email (plus the token
	// digest every row has) — the wire layer must redact both.
	return services.InviteResult{Invite: db.PairSessionInvite{
		ID:                  "i1",
		SessionID:           id,
		Role:                "viewer",
		TokenHash:           "sekret-digest",
		LowerEmail:          pgtype.Text{String: "private@example.com", Valid: true},
		LowerGithubUsername: pgtype.Text{String: username, Valid: true},
	}, Token: "raw"}, f.err
}

func (f *fakePairSessions) ListInvites(_ context.Context, id string, actor int64) ([]db.PairSessionInvite, error) {
	f.lastActor, f.lastID = actor, id
	return nil, f.err
}

func (f *fakePairSessions) RevokeInvite(_ context.Context, id string, actor int64, email string) error {
	f.lastActor, f.lastID, f.lastInviteKey = actor, id, "email:"+email
	return f.err
}

func (f *fakePairSessions) RevokeInviteByUsername(_ context.Context, id string, actor int64, username string) error {
	f.lastActor, f.lastID, f.lastInviteKey = actor, id, "username:"+username
	return f.err
}

func (f *fakePairSessions) MintLink(_ context.Context, id string, actor int64, _ string) (db.PairSessionLink, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairSessionLink{}, f.err
}

func (f *fakePairSessions) ListLinks(_ context.Context, id string, actor int64) ([]db.PairSessionLink, error) {
	f.lastActor, f.lastID = actor, id
	return nil, f.err
}

func (f *fakePairSessions) RevokeLink(_ context.Context, id string, actor int64, linkID string) error {
	f.lastActor, f.lastID, f.lastLinkID = actor, id, linkID
	return f.err
}

func (f *fakePairSessions) Enqueue(_ context.Context, id string, actor int64, source, body string) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastSource, f.lastBody = actor, id, source, body
	if f.err != nil {
		return db.PairPromptQueue{}, f.err
	}
	return f.enqueued, nil
}

func (f *fakePairSessions) ListQueue(_ context.Context, id string, actor int64) ([]db.PairPromptQueue, error) {
	f.lastActor, f.lastID = actor, id
	return nil, f.err
}

func (f *fakePairSessions) Claim(_ context.Context, id string, actor int64, promptID, _ string, _ time.Duration) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastPromptID = actor, id, promptID
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) Start(_ context.Context, id string, actor int64, promptID, _, _ string) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastPromptID = actor, id, promptID
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) Renew(_ context.Context, id string, actor int64, promptID, _ string, _ time.Duration) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastPromptID = actor, id, promptID
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) Finish(_ context.Context, id string, actor int64, promptID, _, _ string) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastPromptID = actor, id, promptID
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) Cancel(_ context.Context, id string, actor int64, promptID string) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID, f.lastPromptID = actor, id, promptID
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) GetDraft(_ context.Context, id string, actor int64) (db.PairSessionDraft, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairSessionDraft{}, f.err
}

func (f *fakePairSessions) PutDraft(_ context.Context, id string, actor int64, _ string, _ int64) (db.PairSessionDraft, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairSessionDraft{}, f.err
}

func (f *fakePairSessions) SubmitDraft(_ context.Context, id string, actor int64) (db.PairPromptQueue, error) {
	f.lastActor, f.lastID = actor, id
	return db.PairPromptQueue{}, f.err
}

func (f *fakePairSessions) Heartbeat(_ context.Context, id string, actor int64, _ json.RawMessage) error {
	f.lastActor, f.lastID = actor, id
	return f.err
}

// servePairSession routes req through a fully-mounted PairSessionHandler,
// optionally injecting an authenticated user into the context (mirroring what
// AuthLoader + RequireAuth do in production). Authenticated requests carry the
// CSRF double-submit pair, like a real cookie-authed SPA. Resolve GETs use the
// side-effect-free preview methods; explicit POST joins materialize membership.
func servePairSession(h *PairSessionHandler, req *http.Request, userID int64, authed bool) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	if authed {
		req.Header.Set("X-CSRF-Token", "test-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "test-csrf"})
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Session-authenticated user: IsTokenAuth=false so RequireScope
				// bypasses token-scope checks, exactly like cookie auth in prod.
				ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
					User:        &db.User{ID: userID, Username: "member"},
					IsTokenAuth: false,
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
	h.Mount(router)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestPairSession_EnqueueForwardsActorAndSucceeds proves the happy path: an
// authenticated editor's enqueue reaches the service with the real signed-in
// user id as the actor and returns 201 with the queued row.
func TestPairSession_EnqueueForwardsActorAndSucceeds(t *testing.T) {
	fake := &fakePairSessions{enqueued: db.PairPromptQueue{ID: "p1", SessionID: "sess1", Seq: 1, Status: "queued"}}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/queue",
		strings.NewReader(`{"source":"solo","body":"do the thing"}`))
	rec := servePairSession(h, req, 42, true)

	if rec.Code != http.StatusCreated {
		t.Fatalf("editor enqueue: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastActor != 42 {
		t.Fatalf("actor: got %d want 42 (must be the real signed-in user)", fake.lastActor)
	}
	if fake.lastID != "sess1" || fake.lastBody != "do the thing" || fake.lastSource != "solo" {
		t.Fatalf("params not forwarded: id=%q source=%q body=%q", fake.lastID, fake.lastSource, fake.lastBody)
	}
}

// TestPairSession_ViewerEnqueueForbidden proves the viewer-403 enforcement is
// reachable over HTTP: when the service denies (as it does for a viewer hitting
// the editor-only enqueue route), the handler returns 403 — not a 500 or a
// silent 200.
func TestPairSession_ViewerEnqueueForbidden(t *testing.T) {
	fake := &fakePairSessions{err: pkgerrors.Forbidden("editor access required")}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/queue",
		strings.NewReader(`{"source":"solo","body":"x"}`))
	rec := servePairSession(h, req, 7, true)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("viewer enqueue: got %d want 403 (%s)", rec.Code, rec.Body.String())
	}
}

// TestPairSession_UnauthenticatedRejected proves no pair-session route is
// reachable without a signed-in user — the browser never holds a plue credential
// and there is no anonymous/key path.
func TestPairSession_UnauthenticatedRejected(t *testing.T) {
	fake := &fakePairSessions{}
	h := NewPairSessionHandler(fake)

	routesToCheck := []struct {
		method, path, body string
	}{
		{http.MethodPost, "/api/pair-sessions", `{"repositoryId":1,"sourceWorkspaceId":"ws"}`},
		{http.MethodGet, "/api/pair-sessions/sess1", ``},
		{http.MethodPost, "/api/pair-sessions/sess1/queue", `{"source":"solo","body":"x"}`},
		{http.MethodPost, "/api/pair-sessions/sess1/end", ``},
	}
	for _, rc := range routesToCheck {
		var body *strings.Reader
		if rc.body != "" {
			body = strings.NewReader(rc.body)
		} else {
			body = strings.NewReader("")
		}
		req := httptest.NewRequest(rc.method, rc.path, body)
		rec := servePairSession(h, req, 0, false)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s unauthenticated: got %d want 401 (%s)", rc.method, rc.path, rec.Code, rec.Body.String())
		}
	}
	if fake.lastActor != 0 {
		t.Fatalf("service must not be called for an unauthenticated request (actor=%d)", fake.lastActor)
	}
}

// TestPairSession_ResolveReturnsRoleAndNotFound proves the resolve route surfaces
// the visitor's effective role on success and maps the service's NotFound (an
// unknown/ended session) to an honest 404 — never a key-entry form.
func TestPairSession_ResolveReturnsRoleAndNotFound(t *testing.T) {
	fake := &fakePairSessions{resolution: services.PairResolution{
		Session: db.PairSession{ID: "sess1", Status: "active"},
		Role:    services.PairRoleViewer,
	}}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodGet, "/api/pair-sessions/sess1", nil)
	rec := servePairSession(h, req, 5, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("resolve: got %d want 200 (%s)", rec.Code, rec.Body.String())
	}
	var resp struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Role != services.PairRoleViewer {
		t.Fatalf("role: got %q want viewer", resp.Role)
	}

	fake.err = pkgerrors.NotFound("pair session not found")
	req = httptest.NewRequest(http.MethodGet, "/api/pair-sessions/ghost", nil)
	rec = servePairSession(h, req, 5, true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("resolve unknown: got %d want 404 (%s)", rec.Code, rec.Body.String())
	}
}

// TestPairSession_ResolveGETsRequireCSRFForSessionAuth proves the preview GETs
// retain defense-in-depth CSRF protection for cookie-authenticated browsers.
// The handler is compile-time constrained to call Preview* methods, so these
// requests cannot materialize membership even when the CSRF pair is present.
func TestPairSession_ResolveGETsRequireCSRFForSessionAuth(t *testing.T) {
	tests := []struct {
		path     string
		wantCall string
	}{
		{path: "/api/pair-sessions?sourceWorkspaceId=11111111-1111-1111-1111-111111111111", wantCall: "preview-source"},
		{path: "/api/pair-sessions/sess1", wantCall: "preview-session"},
		{path: "/api/pair-sessions/by-link/slug1", wantCall: "preview-link"},
	}
	serveWithAuth := func(h *PairSessionHandler, req *http.Request, tokenAuth bool) *httptest.ResponseRecorder {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
					User:        &db.User{ID: 9, Username: "victim"},
					IsTokenAuth: tokenAuth,
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
		h.Mount(router)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	for _, tt := range tests {
		// Cookie-session GET without the CSRF pair (a cross-site navigation):
		// 403, and the service — hence any join — is never reached.
		fake := &fakePairSessions{}
		h := NewPairSessionHandler(fake)
		rec := serveWithAuth(h, httptest.NewRequest(http.MethodGet, tt.path, nil), false)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s session-auth without CSRF: got %d want 403 (%s)", tt.path, rec.Code, rec.Body.String())
		}
		if fake.lastActor != 0 {
			t.Fatalf("%s session-auth without CSRF: service must not be called (actor=%d)", tt.path, fake.lastActor)
		}

		// Cookie-session GET WITH the double-submit pair (a real SPA): allowed.
		req := httptest.NewRequest(http.MethodGet, tt.path, nil)
		req.Header.Set("X-CSRF-Token", "tok")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "tok"})
		rec = serveWithAuth(h, req, false)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s session-auth with CSRF: got %d want 200 (%s)", tt.path, rec.Code, rec.Body.String())
		}
		if fake.lastCall != tt.wantCall {
			t.Fatalf("%s dispatched %q want %q", tt.path, fake.lastCall, tt.wantCall)
		}

		// Token auth (e.g. the multi Worker's bearer): exempt, no header needed.
		fake = &fakePairSessions{}
		h = NewPairSessionHandler(fake)
		rec = serveWithAuth(h, httptest.NewRequest(http.MethodGet, tt.path, nil), true)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s token-auth: got %d want 200 (%s)", tt.path, rec.Code, rec.Body.String())
		}
		if fake.lastActor != 9 {
			t.Fatalf("%s token-auth: service not reached (actor=%d)", tt.path, fake.lastActor)
		}
		if fake.lastCall != tt.wantCall {
			t.Fatalf("%s token-auth dispatched %q want %q", tt.path, fake.lastCall, tt.wantCall)
		}
	}

	for _, tt := range []struct {
		path     string
		wantCall string
	}{
		{path: "/api/pair-sessions/sess1/join", wantCall: "join-session"},
		{path: "/api/pair-sessions/by-link/slug1/join", wantCall: "join-link"},
	} {
		fake := &fakePairSessions{}
		rec := servePairSession(NewPairSessionHandler(fake), httptest.NewRequest(http.MethodPost, tt.path, nil), 9, true)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: got %d want 200 (%s)", tt.path, rec.Code, rec.Body.String())
		}
		if fake.lastCall != tt.wantCall {
			t.Fatalf("%s dispatched %q want %q", tt.path, fake.lastCall, tt.wantCall)
		}
	}
}

// TestPairSession_InviteDispatchesEmailOrUsername proves the invite route's
// exactly-one-key contract: an email body reaches CreateInvite, a username body
// reaches CreateInviteByUsername, and both/neither are rejected with 400 before
// the service is touched.
func TestPairSession_InviteDispatchesEmailOrUsername(t *testing.T) {
	fake := &fakePairSessions{}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/invites",
		strings.NewReader(`{"email":"friend@example.com","role":"editor"}`))
	rec := servePairSession(h, req, 9, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("email invite: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastInviteKey != "email:friend@example.com" {
		t.Fatalf("email invite dispatched to %q", fake.lastInviteKey)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/invites",
		strings.NewReader(`{"username":"octocat","role":"viewer"}`))
	rec = servePairSession(h, req, 9, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("username invite: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastInviteKey != "username:octocat" {
		t.Fatalf("username invite dispatched to %q", fake.lastInviteKey)
	}

	for _, body := range []string{
		`{"role":"viewer"}`,
		`{"email":"a@b.c","username":"octocat","role":"viewer"}`,
	} {
		fake.lastInviteKey = ""
		req = httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/invites", strings.NewReader(body))
		rec = servePairSession(h, req, 9, true)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: got %d want 400 (%s)", body, rec.Code, rec.Body.String())
		}
		if fake.lastInviteKey != "" {
			t.Fatalf("service must not be called for body %s (got %q)", body, fake.lastInviteKey)
		}
	}
}

// TestPairSession_RevokeInviteByUsername proves the revoke route accepts a
// username key (query or body) and dispatches to the username revocation.
func TestPairSession_RevokeInviteByUsername(t *testing.T) {
	fake := &fakePairSessions{}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodDelete, "/api/pair-sessions/sess1/invites?username=octocat", nil)
	rec := servePairSession(h, req, 9, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke by username: got %d want 200 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastInviteKey != "username:octocat" {
		t.Fatalf("revoke dispatched to %q", fake.lastInviteKey)
	}
}

// TestPairSession_LookupForSource proves the share modal's open-time lookup
// forwards the workspace id and the real visitor, and surfaces the honest 404
// when no session is live for that workspace.
func TestPairSession_LookupForSource(t *testing.T) {
	fake := &fakePairSessions{resolution: services.PairResolution{
		Session: db.PairSession{ID: "sess1", Status: "active"},
		Role:    services.PairRoleOwner,
	}}
	h := NewPairSessionHandler(fake)

	// Workspace ids are UUIDs (the source-lookup query casts to uuid).
	const src1 = "11111111-1111-1111-1111-111111111111"
	const src2 = "22222222-2222-2222-2222-222222222222"

	req := httptest.NewRequest(http.MethodGet, "/api/pair-sessions?sourceWorkspaceId="+src1, nil)
	rec := servePairSession(h, req, 11, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup: got %d want 200 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastSource != src1 || fake.lastActor != 11 {
		t.Fatalf("lookup forwarded source=%q actor=%d", fake.lastSource, fake.lastActor)
	}

	fake.err = pkgerrors.NotFound("no live pair session for this workspace")
	req = httptest.NewRequest(http.MethodGet, "/api/pair-sessions?sourceWorkspaceId="+src2, nil)
	rec = servePairSession(h, req, 11, true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("lookup miss: got %d want 404 (%s)", rec.Code, rec.Body.String())
	}

	// A malformed (non-UUID) sourceWorkspaceId is a client 400 BEFORE the query
	// runs — never a 500 that leaks Postgres' 22P02 cast error to the caller.
	fake.err = nil
	fake.lastSource = ""
	req = httptest.NewRequest(http.MethodGet, "/api/pair-sessions?sourceWorkspaceId=not-a-uuid", nil)
	rec = servePairSession(h, req, 11, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed source: got %d want 400 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastSource != "" {
		t.Fatalf("malformed source must not reach the service (got source=%q)", fake.lastSource)
	}
}

// TestPairSession_MalformedUUIDPathParamsRejected proves path params that back
// uuid columns are rejected at the HTTP boundary, before pgx/Postgres can turn
// them into raw internal errors.
func TestPairSession_MalformedUUIDPathParamsRejected(t *testing.T) {
	cases := []struct {
		name    string
		method  string
		path    string
		body    string
		message string
	}{
		{"revoke_link", http.MethodDelete, "/api/pair-sessions/sess1/links/not-a-uuid", "", "invalid linkId"},
		{"claim", http.MethodPost, "/api/pair-sessions/sess1/queue/not-a-uuid/claim", `{"clientId":"c1"}`, "invalid promptId"},
		{"start", http.MethodPost, "/api/pair-sessions/sess1/queue/not-a-uuid/start", `{"clientId":"c1","runId":"r1"}`, "invalid promptId"},
		{"renew", http.MethodPost, "/api/pair-sessions/sess1/queue/not-a-uuid/renew", `{"clientId":"c1"}`, "invalid promptId"},
		{"finish", http.MethodPost, "/api/pair-sessions/sess1/queue/not-a-uuid/finish", `{"clientId":"c1","status":"completed"}`, "invalid promptId"},
		{"cancel", http.MethodPost, "/api/pair-sessions/sess1/queue/not-a-uuid/cancel", "", "invalid promptId"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakePairSessions{}
			h := NewPairSessionHandler(fake)
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			rec := servePairSession(h, req, 11, true)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s: got %d want 400 (%s)", tc.name, rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.message) {
				t.Fatalf("%s: body %q missing %q", tc.name, rec.Body.String(), tc.message)
			}
			if fake.lastID != "" || fake.lastLinkID != "" || fake.lastPromptID != "" {
				t.Fatalf("%s: malformed id must not reach service (session=%q link=%q prompt=%q)", tc.name, fake.lastID, fake.lastLinkID, fake.lastPromptID)
			}
		})
	}
}

// TestPairSession_InviteWireShapeRedactsSecrets proves the invite JSON never
// carries token_hash, and a username-keyed invite never round-trips a stored
// email — the wire-privacy contract behind invite-by-username.
func TestPairSession_InviteWireShapeRedactsSecrets(t *testing.T) {
	fake := &fakePairSessions{}
	h := NewPairSessionHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/pair-sessions/sess1/invites",
		strings.NewReader(`{"username":"octocat","role":"viewer"}`))
	rec := servePairSession(h, req, 9, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("username invite: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "token_hash") {
		t.Fatalf("invite JSON must not leak token_hash: %s", body)
	}
	if strings.Contains(body, "lower_email") {
		t.Fatalf("a username invite's JSON must not carry any email: %s", body)
	}
}

// A fine-grained read:user token must NOT be able to drive pair-session
// mutations (create -> forks a VM, invite, cancel a prompt). RequireScope(ScopeWriteUser) rejects at middleware before
// the handler runs, so a nil service is never reached on the rejection path.
func TestPairSession_MutationsRequireWriteScope(t *testing.T) {
	newRouter := func(scopes string) http.Handler {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
					User:        &db.User{ID: 1, Username: "reader"},
					IsTokenAuth: true,
					Scopes:      middleware.ParseTokenScopes(scopes),
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
		(&PairSessionHandler{}).Mount(router)
		return router
	}

	mutations := []struct{ method, path string }{
		{http.MethodPost, "/api/pair-sessions"},
		{http.MethodPost, "/api/pair-sessions/s1/end"},
		{http.MethodPost, "/api/pair-sessions/s1/invites"},
		{http.MethodDelete, "/api/pair-sessions/s1/members/2"},
		{http.MethodPost, "/api/pair-sessions/s1/queue/9/cancel"},
		{http.MethodPost, "/api/pair-sessions/s1/presence"},
	}

	readOnly := newRouter("read:user")
	for _, m := range mutations {
		rec := httptest.NewRecorder()
		readOnly.ServeHTTP(rec, httptest.NewRequest(m.method, m.path, nil))
		if rec.Code != http.StatusForbidden {
			t.Errorf("read:user token on %s %s: got %d, want 403 (insufficient scope)", m.method, m.path, rec.Code)
		}
	}

	// A write:user token clears the write-scope gate on those same mutations (it
	// would then reach the handler, so we only assert it is NOT a scope 403).
	writeUser := newRouter("write:user")
	rec := httptest.NewRecorder()
	func() {
		defer func() { _ = recover() }() // nil service panics past the gate; that's fine
		writeUser.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/pair-sessions/s1/members/2", nil))
	}()
	if rec.Code == http.StatusForbidden {
		t.Errorf("write:user token must clear the write-scope gate, got 403")
	}
}
