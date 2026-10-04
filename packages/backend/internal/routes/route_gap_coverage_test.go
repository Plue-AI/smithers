package routes

// Route tests for auth-sensitive and mutating handlers that had no route-level
// coverage: each gets an unauthenticated case, a happy case that proves the
// handler passes the caller's identity and inputs through, and a service-error
// case that proves the error status is preserved.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

// ---- agent environment writes ----

type agentEnvironmentWriteRecorder struct {
	agentEnvironmentRouteMock
	err        error
	actorID    int64
	owner      string
	repo       string
	put        services.PutAgentEnvironmentInput
	deleteName string
}

func (m *agentEnvironmentWriteRecorder) PutAgentEnvironment(_ context.Context, actor *db.User, owner, repo string, input services.PutAgentEnvironmentInput) (services.AgentEnvironmentResponse, error) {
	m.actorID, m.owner, m.repo, m.put = actor.ID, owner, repo, input
	return services.AgentEnvironmentResponse{SetupScript: input.SetupScript}, m.err
}

func (m *agentEnvironmentWriteRecorder) DeleteAgentEnvironmentSecret(_ context.Context, actor *db.User, owner, repo, name string) error {
	m.actorID, m.owner, m.repo, m.deleteName = actor.ID, owner, repo, name
	return m.err
}

func unauthenticatedRouteRequest(method, target, body string, params map[string]string) *http.Request {
	return withRouteParams(httptest.NewRequest(method, target, strings.NewReader(body)), params)
}

func TestPutAgentEnvironment_Route(t *testing.T) {
	t.Parallel()
	const target = "/api/repos/alice/demo/agent-environment"

	t.Run("requires auth", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).PutAgentEnvironment(rec, unauthenticatedRouteRequest(http.MethodPut, target, `{}`, map[string]string{"owner": "alice", "repo": "demo"}))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Zero(t, svc.actorID)
	})

	t.Run("rejects unknown fields", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).PutAgentEnvironment(rec, agentEnvironmentRouteRequest(http.MethodPut, target, `{"secret_value":"x"}`))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		assert.Zero(t, svc.actorID)
	})

	t.Run("writes as the caller", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).PutAgentEnvironment(rec, agentEnvironmentRouteRequest(http.MethodPut, target, `{"setup_script":"npm ci"}`))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, int64(7), svc.actorID)
		assert.Equal(t, "alice", svc.owner)
		assert.Equal(t, "demo", svc.repo)
		assert.Equal(t, "npm ci", svc.put.SetupScript)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{err: pkgerrors.Forbidden("write access required")}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).PutAgentEnvironment(rec, agentEnvironmentRouteRequest(http.MethodPut, target, `{"setup_script":"npm ci"}`))
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})
}

func TestDeleteAgentEnvironmentSecret_Route(t *testing.T) {
	t.Parallel()
	const target = "/api/repos/alice/demo/agent-environment/secrets/SETUP_TOKEN"

	t.Run("requires auth", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).DeleteAgentEnvironmentSecret(rec, unauthenticatedRouteRequest(http.MethodDelete, target, "", map[string]string{"owner": "alice", "repo": "demo", "name": "SETUP_TOKEN"}))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Empty(t, svc.deleteName)
	})

	t.Run("deletes as the caller", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).DeleteAgentEnvironmentSecret(rec, agentEnvironmentRouteRequest(http.MethodDelete, target, ""))
		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Equal(t, int64(7), svc.actorID)
		assert.Equal(t, "SETUP_TOKEN", svc.deleteName)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &agentEnvironmentWriteRecorder{err: pkgerrors.NotFound("secret not found")}
		rec := httptest.NewRecorder()
		(&SecretHandler{AgentEnvironment: svc}).DeleteAgentEnvironmentSecret(rec, agentEnvironmentRouteRequest(http.MethodDelete, target, ""))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}

// ---- landing request idempotent create ----

func TestPutLandingRequest_Route(t *testing.T) {
	t.Parallel()
	params := func(id string) map[string]string {
		return map[string]string{"owner": "alice", "repo": "demo", "request_uuid": id}
	}
	const body = `{"title":"t","target_bookmark":"main","change_ids":["k1"]}`

	t.Run("requires request uuid", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := withAuth(unauthenticatedRouteRequest(http.MethodPut, "/", body, params("")), 1, "alice")
		(&LandingHandler{Service: &mockLandingRouteService{}}).PutLandingRequest(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&LandingHandler{Service: &mockLandingRouteService{}}).PutLandingRequest(rec, unauthenticatedRouteRequest(http.MethodPut, "/", body, params("req-1")))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("passes the request id as the idempotency key", func(t *testing.T) {
		var got services.CreateLandingRequestInput
		var actorID int64
		svc := &mockLandingRouteService{createLandingFn: func(_ context.Context, actor *db.User, _, _ string, in services.CreateLandingRequestInput) (services.LandingRequestResponse, error) {
			actorID, got = actor.ID, in
			return sampleLandingResponse(), nil
		}}
		rec := httptest.NewRecorder()
		req := withAuth(unauthenticatedRouteRequest(http.MethodPut, "/", body, params("req-1")), 1, "alice")
		(&LandingHandler{Service: svc}).PutLandingRequest(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		assert.Equal(t, int64(1), actorID)
		assert.Equal(t, "req-1", got.RequestID)
		assert.Equal(t, []string{"k1"}, got.ChangeIDs)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &mockLandingRouteService{createLandingFn: func(context.Context, *db.User, string, string, services.CreateLandingRequestInput) (services.LandingRequestResponse, error) {
			return services.LandingRequestResponse{}, pkgerrors.Conflict("request id reused with a different body")
		}}
		rec := httptest.NewRecorder()
		req := withAuth(unauthenticatedRouteRequest(http.MethodPut, "/", body, params("req-1")), 1, "alice")
		(&LandingHandler{Service: svc}).PutLandingRequest(rec, req)
		assert.Equal(t, http.StatusConflict, rec.Code)
	})
}

// ---- branch lock release ----

// ---- org provider connections ----

type orgProviderConnectionRecorder struct {
	stubProviderConnectionService
	err     error
	actorID int64
	org     string
	in      services.ConnectProviderInput
}

func (s *orgProviderConnectionRecorder) ConnectForOrg(_ context.Context, actor *db.User, org string, in services.ConnectProviderInput) (services.ProviderConnectionResponse, error) {
	s.actorID, s.org, s.in = actor.ID, org, in
	return services.ProviderConnectionResponse{ID: "conn-org", OwnerType: "org"}, s.err
}

func TestConnectOrg_Route(t *testing.T) {
	t.Parallel()
	const body = `{"provider":"claude","kind":"api_key","access_token":"tok"}`
	params := map[string]string{"org": "acme"}

	t.Run("requires auth", func(t *testing.T) {
		svc := &orgProviderConnectionRecorder{}
		rec := httptest.NewRecorder()
		(&ProviderConnectionHandler{Service: svc}).ConnectOrg(rec, unauthenticatedRouteRequest(http.MethodPost, "/api/orgs/acme/provider-connections", body, params))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Zero(t, svc.actorID)
	})

	t.Run("connects for the named org as the caller", func(t *testing.T) {
		svc := &orgProviderConnectionRecorder{}
		rec := httptest.NewRecorder()
		req := withAuth(unauthenticatedRouteRequest(http.MethodPost, "/api/orgs/acme/provider-connections", body, params), 9, "owner")
		(&ProviderConnectionHandler{Service: svc}).ConnectOrg(rec, req)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		assert.Equal(t, int64(9), svc.actorID)
		assert.Equal(t, "acme", svc.org)
		assert.Equal(t, "claude", svc.in.Provider)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &orgProviderConnectionRecorder{err: pkgerrors.Forbidden("org owner required")}
		rec := httptest.NewRecorder()
		req := withAuth(unauthenticatedRouteRequest(http.MethodPost, "/api/orgs/acme/provider-connections", body, params), 9, "member")
		(&ProviderConnectionHandler{Service: svc}).ConnectOrg(rec, req)
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})
}

// ---- wiki collaboration reads ----

type failingWikiService struct {
	wikiRoutesFixture
	err error
}

func (f *failingWikiService) GetWikiDocument(context.Context, *db.User, string, string, string) (services.WikiDocumentResponse, error) {
	return services.WikiDocumentResponse{}, f.err
}

func (f *failingWikiService) ListWikiUpdates(context.Context, *db.User, string, string, string, int64, int64) ([]services.WikiUpdateEvent, error) {
	return nil, f.err
}

func TestWikiCollaborationDocument_Route(t *testing.T) {
	t.Parallel()

	t.Run("serves an uncached document", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Document(rec, wikiRequest(http.MethodGet, "/", ""))
		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		assert.Contains(t, rec.Body.String(), `"AAA="`)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &failingWikiService{err: pkgerrors.NotFound("wiki page not found")}}).Document(rec, wikiRequest(http.MethodGet, "/", ""))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("requires a slug", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/", nil), map[string]string{"owner": "alice", "repo": "demo"})
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Document(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})
}

func TestWikiCollaborationUpdates_Route(t *testing.T) {
	t.Parallel()

	t.Run("lists updates after the cursor", func(t *testing.T) {
		f := &wikiRoutesFixture{events: []services.WikiUpdateEvent{{Revision: 1}, {Revision: 2}, {Revision: 3}}}
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: f}).Updates(rec, wikiRequest(http.MethodGet, "/?page_id=42&after=1", ""))
		require.Equal(t, http.StatusOK, rec.Code)
		var got []services.WikiUpdateEvent
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
		require.Len(t, got, 2)
		assert.Equal(t, int64(2), got[0].Revision)
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	})

	t.Run("rejects a missing page id", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Updates(rec, wikiRequest(http.MethodGet, "/", ""))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &failingWikiService{err: pkgerrors.Forbidden("read access required")}}).Updates(rec, wikiRequest(http.MethodGet, "/?page_id=42", ""))
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})
}

// The live path needs a Postgres broker and is covered by
// TestWikiCollaborationSSEReplayLiveAndRevocation; these are the refusals
// that must happen before any subscription opens.
func TestWikiCollaborationStream_RefusesBeforeSubscribing(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		req := withRouteParams(httptest.NewRequest(http.MethodGet, "/?page_id=42", nil), map[string]string{"owner": "alice", "repo": "demo", "slug": "home"})
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Stream(rec, req)
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("rejects an invalid cursor", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Stream(rec, wikiRequest(http.MethodGet, "/?page_id=42&after=-1", ""))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("checks read access through the service", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &failingWikiService{err: pkgerrors.Forbidden("read access required")}}).Stream(rec, wikiRequest(http.MethodGet, "/?page_id=42", ""))
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})

	t.Run("fails closed without a broker", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WikiCollaborationHandler{Service: &wikiRoutesFixture{}}).Stream(rec, wikiRequest(http.MethodGet, "/?page_id=42", ""))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

// ---- workflow run status stream ----

func TestWorkflowRunStatusStream_Route(t *testing.T) {
	statusRequest := func(id string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/runs/"+id+"/status/stream", nil)
		return withRouteParams(req, map[string]string{"id": id})
	}

	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}).WorkflowRunStatusStream(rec, statusRequest("5"))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("rejects an invalid run id", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&WorkflowRunHandler{Service: &mockWorkflowRunRouteService{}}).WorkflowRunStatusStream(rec, withAuth(statusRequest("0"), 1, "alice"))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &mockWorkflowRunRouteService{getWorkflowRunFn: func(context.Context, int64, int64) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pkgerrors.NotFound("workflow run not found")
		}}
		req := withAuth(withRepoInContext(statusRequest("5"), &db.Repository{ID: 101}), 1, "alice")
		rec := httptest.NewRecorder()
		(&WorkflowRunHandler{Service: svc}).WorkflowRunStatusStream(rec, req)
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("subscribes to the run channel and opens with a fresh snapshot", func(t *testing.T) {
		oldServe := serveWorkflowRunBrokerSSE
		t.Cleanup(func() { serveWorkflowRunBrokerSSE = oldServe })
		previous := currentRevocationSource()
		SetRevocationSource(revocation.NewBus(nil, nil))
		t.Cleanup(func() { SetRevocationSource(previous) })
		var gotCfg sse.BrokerStreamConfig
		serveWorkflowRunBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
			gotCfg = cfg
			cfg.OnConnect(w, r, w.(http.Flusher))
		}
		reads := 0
		svc := &mockWorkflowRunRouteService{getWorkflowRunFn: func(_ context.Context, repoID, runID int64) (db.WorkflowRun, error) {
			reads++
			status := "running"
			if reads > 1 {
				status = "success"
			}
			return db.WorkflowRun{ID: runID, RepositoryID: repoID, Status: status}, nil
		}}
		req := withAuth(withRepoInContext(statusRequest("5"), &db.Repository{ID: 101}), 3, "alice")
		rec := httptest.NewRecorder()
		(&WorkflowRunHandler{Service: svc, Broker: &sse.Broker{}}).WorkflowRunStatusStream(rec, req)

		assert.Equal(t, []string{"workflow_run_events_5"}, gotCfg.Channels)
		assert.Equal(t, int64(3), gotCfg.UserID)
		assert.Equal(t, int64(101), gotCfg.Principal.RepositoryID)
		// The snapshot is re-read after subscribe, so a transition that fired
		// before the subscription is still reported.
		assert.Contains(t, rec.Body.String(), `"status":"success"`)
		assert.Contains(t, rec.Body.String(), `"source":"snapshot"`)
	})
}

// ---- issue state facts ----

type issueStateRouteRecorder struct {
	authorizeErr error
	listErr      error
	repo         db.Repository
	actorID      int64
	repoID       int64
	after        int64
	limit        int
	page         services.IssueStateFactPage
}

func (s *issueStateRouteRecorder) ListIssueEvents(context.Context, *db.User, string, string, int64, int, int) ([]services.IssueEventResponse, error) {
	return nil, nil
}

func (s *issueStateRouteRecorder) AuthorizeIssueState(context.Context, *db.User, string, string) (db.Repository, error) {
	return s.repo, s.authorizeErr
}

func (s *issueStateRouteRecorder) ListIssueStateFacts(_ context.Context, actor *db.User, _, _ string, repoID, after int64, limit int) (services.IssueStateFactPage, error) {
	s.actorID, s.repoID, s.after, s.limit = actor.ID, repoID, after, limit
	return s.page, s.listErr
}

func issueStateRequest(target string) *http.Request {
	return withRouteParams(httptest.NewRequest(http.MethodGet, target, nil), map[string]string{"owner": "alice", "repo": "demo"})
}

func TestListIssueStateFacts_Route(t *testing.T) {
	t.Parallel()

	t.Run("requires auth", func(t *testing.T) {
		svc := &issueStateRouteRecorder{}
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: svc}).ListIssueStateFacts(rec, issueStateRequest("/"))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.Zero(t, svc.actorID)
	})

	t.Run("rejects bad cursor and limit", func(t *testing.T) {
		for _, target := range []string{"/?after=-1", "/?after=x", "/?limit=0", "/?limit=1001", "/?limit=x"} {
			rec := httptest.NewRecorder()
			(&IssueEventHandler{Service: &issueStateRouteRecorder{}}).ListIssueStateFacts(rec, withAuth(issueStateRequest(target), 1, "alice"))
			assert.Equal(t, http.StatusBadRequest, rec.Code, target)
		}
	})

	t.Run("fails closed without the journal service", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: &mockIssueEventRouteServiceOnly{}}).ListIssueStateFacts(rec, withAuth(issueStateRequest("/"), 1, "alice"))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("pages as the caller", func(t *testing.T) {
		svc := &issueStateRouteRecorder{page: services.IssueStateFactPage{Cursor: 12, Head: 12}}
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: svc}).ListIssueStateFacts(rec, withAuth(issueStateRequest("/?after=10&limit=50"), 4, "alice"))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, int64(4), svc.actorID)
		assert.Equal(t, int64(10), svc.after)
		assert.Equal(t, 50, svc.limit)
		assert.Contains(t, rec.Body.String(), `"cursor":12`)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: &issueStateRouteRecorder{listErr: pkgerrors.Forbidden("read access required")}}).ListIssueStateFacts(rec, withAuth(issueStateRequest("/"), 1, "alice"))
		assert.Equal(t, http.StatusForbidden, rec.Code)
	})
}

type mockIssueEventRouteServiceOnly struct{}

func (mockIssueEventRouteServiceOnly) ListIssueEvents(context.Context, *db.User, string, string, int64, int, int) ([]services.IssueEventResponse, error) {
	return nil, nil
}

func TestIssueStateFactsStream_Route(t *testing.T) {
	t.Run("requires auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: &issueStateRouteRecorder{}}).IssueStateFactsStream(rec, issueStateRequest("/"))
		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("checks read access before streaming", func(t *testing.T) {
		svc := &issueStateRouteRecorder{authorizeErr: pkgerrors.NotFound("repository not found")}
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: svc}).IssueStateFactsStream(rec, withAuth(issueStateRequest("/"), 1, "alice"))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("replays facts from the cursor under an org principal", func(t *testing.T) {
		oldServe := serveIssueStateBrokerSSE
		t.Cleanup(func() { serveIssueStateBrokerSSE = oldServe })
		previous := currentRevocationSource()
		SetRevocationSource(revocation.NewBus(nil, nil))
		t.Cleanup(func() { SetRevocationSource(previous) })

		var gotCfg sse.BrokerStreamConfig
		serveIssueStateBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
			gotCfg = cfg
			cfg.OnConnect(w, r, w.(http.Flusher))
		}
		svc := &issueStateRouteRecorder{
			repo: db.Repository{ID: 101, OrgID: pgtype.Int8{Int64: 55, Valid: true}},
			page: services.IssueStateFactPage{Cursor: 8, Events: []services.IssueStateFact{{ID: "f8", Sequence: 8}}},
		}
		req := withAuth(issueStateRequest("/?after=7"), 4, "alice")
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: svc, Broker: &sse.Broker{}}).IssueStateFactsStream(rec, req)

		assert.Equal(t, "issue_state_facts_101", gotCfg.Channel)
		assert.Equal(t, int64(4), gotCfg.UserID)
		assert.Equal(t, revocation.Principal{UserID: 4, RepositoryID: 101, OrganizationID: 55}, gotCfg.Principal)
		assert.Equal(t, int64(101), svc.repoID)
		assert.Equal(t, int64(7), svc.after)
		assert.Contains(t, rec.Body.String(), "id: 8\n")
		assert.Contains(t, rec.Body.String(), "event: issue.fact\n")
	})

	t.Run("head refuses a repository swapped mid-stream", func(t *testing.T) {
		oldServe := serveIssueStateBrokerSSE
		t.Cleanup(func() { serveIssueStateBrokerSSE = oldServe })
		svc := &issueStateRouteRecorder{repo: db.Repository{ID: 101}}
		var headErr error
		serveIssueStateBrokerSSE = func(_ http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
			svc.repo = db.Repository{ID: 202}
			_, headErr = cfg.Durable.Head(r.Context())
		}
		rec := httptest.NewRecorder()
		(&IssueEventHandler{Service: svc, Broker: &sse.Broker{}}).IssueStateFactsStream(rec, withAuth(issueStateRequest("/"), 4, "alice"))
		var apiErr *pkgerrors.APIError
		require.ErrorAs(t, headErr, &apiErr)
		assert.Equal(t, http.StatusConflict, apiErr.Status)
	})
}

// ---- sandbox environment images ----

type environmentImageListRecorder struct {
	fakeEnvironmentImageRouteService
	err       error
	listedFor []int64
	retired   string
}

func (f *environmentImageListRecorder) List(_ context.Context, repositoryID int64) ([]services.SandboxEnvironmentImageResponse, error) {
	f.listedFor = append(f.listedFor, repositoryID)
	return []services.SandboxEnvironmentImageResponse{{ID: "img-1", RepositoryID: repositoryID}}, f.err
}

func (f *environmentImageListRecorder) Retire(_ context.Context, repositoryID int64, id string) (services.SandboxEnvironmentImageResponse, error) {
	f.retired = id
	return services.SandboxEnvironmentImageResponse{ID: id, RepositoryID: repositoryID}, f.err
}

func TestSandboxEnvironmentImage_ListAndRetireRoutes(t *testing.T) {
	t.Parallel()
	repoRequest := func(method string, params map[string]string) *http.Request {
		return withWorkspaceRepoCtx(withRouteParams(httptest.NewRequest(method, "/", nil), params), "alice", "demo")
	}

	t.Run("repo routes require repository context", func(t *testing.T) {
		h := &SandboxEnvironmentImageHandler{Service: &environmentImageListRecorder{}}
		rec := httptest.NewRecorder()
		h.ListRepoImages(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
		rec = httptest.NewRecorder()
		h.RetireRepoImage(rec, httptest.NewRequest(http.MethodDelete, "/", nil))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("lists repository and platform scopes", func(t *testing.T) {
		svc := &environmentImageListRecorder{}
		h := &SandboxEnvironmentImageHandler{Service: svc}
		rec := httptest.NewRecorder()
		h.ListRepoImages(rec, repoRequest(http.MethodGet, nil))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		rec = httptest.NewRecorder()
		h.ListBaseImages(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		require.Equal(t, http.StatusOK, rec.Code)
		require.Len(t, svc.listedFor, 2)
		assert.NotZero(t, svc.listedFor[0])
		assert.Zero(t, svc.listedFor[1], "base images are the platform scope")
	})

	t.Run("retires by id", func(t *testing.T) {
		svc := &environmentImageListRecorder{}
		rec := httptest.NewRecorder()
		(&SandboxEnvironmentImageHandler{Service: svc}).RetireRepoImage(rec, repoRequest(http.MethodDelete, map[string]string{"id": "img-9"}))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Equal(t, "img-9", svc.retired)
	})

	t.Run("retire requires an id", func(t *testing.T) {
		rec := httptest.NewRecorder()
		(&SandboxEnvironmentImageHandler{Service: &environmentImageListRecorder{}}).RetireRepoImage(rec, repoRequest(http.MethodDelete, nil))
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("fails closed without a service", func(t *testing.T) {
		h := &SandboxEnvironmentImageHandler{}
		rec := httptest.NewRecorder()
		h.ListBaseImages(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		rec = httptest.NewRecorder()
		h.RetireRepoImage(rec, repoRequest(http.MethodDelete, map[string]string{"id": "img-9"}))
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("keeps service error status", func(t *testing.T) {
		svc := &environmentImageListRecorder{err: pkgerrors.NotFound("environment image not found")}
		h := &SandboxEnvironmentImageHandler{Service: svc}
		rec := httptest.NewRecorder()
		h.ListRepoImages(rec, repoRequest(http.MethodGet, nil))
		assert.Equal(t, http.StatusNotFound, rec.Code)
		rec = httptest.NewRecorder()
		h.RetireRepoImage(rec, repoRequest(http.MethodDelete, map[string]string{"id": "img-9"}))
		assert.Equal(t, http.StatusNotFound, rec.Code)
	})
}
