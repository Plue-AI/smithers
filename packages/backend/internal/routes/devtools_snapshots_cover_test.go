package routes

import (
	"context"
	"encoding/json"
	stderrors "errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestDevtoolsSnapshots_Cov_RouteRegistrationAndFeatureFlag(t *testing.T) {
	t.Run("nil router or queries is a no-op", func(t *testing.T) {
		require.NotPanics(t, func() {
			RegisterDevtoolsSnapshotRoutes(nil, nil, nil, nil, true)
		})
	})

	t.Run("feature flag disables both handlers", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Queries: &mockDevtoolsSnapshotRouteQuerier{}}

		postReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{}`))
		postReq = withRepoContext(postReq, "alice", "demo")
		postReq = withAuth(postReq, 7, "alice")
		postRec := httptest.NewRecorder()
		handler.PostSnapshot(postRec, postReq)
		require.Equal(t, http.StatusNotFound, postRec.Code)

		getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id=11111111-1111-1111-1111-111111111111", nil)
		getReq = withRepoContext(getReq, "alice", "demo")
		getReq = withAuth(getReq, 7, "alice")
		getRec := httptest.NewRecorder()
		handler.GetSnapshots(getRec, getReq)
		require.Equal(t, http.StatusNotFound, getRec.Code)
	})

	t.Run("unset flag disables routes end to end via registration (#345 regression)", func(t *testing.T) {
		router := chi.NewRouter()
		router.Route("/api/repos/{owner}/{repo}", func(r chi.Router) {
			RegisterDevtoolsSnapshotRoutes(r, &db.Queries{}, nil, nil, false)
		})

		postReq := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{}`))
		postRec := httptest.NewRecorder()
		router.ServeHTTP(postRec, postReq)
		require.Equal(t, http.StatusNotFound, postRec.Code)

		getReq := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id=11111111-1111-1111-1111-111111111111", nil)
		getRec := httptest.NewRecorder()
		router.ServeHTTP(getRec, getReq)
		require.Equal(t, http.StatusNotFound, getRec.Code)
	})
}

func TestDevtoolsSnapshots_Cov_PostSnapshotValidationAndErrors(t *testing.T) {
	sessionID := "11111111-1111-1111-1111-111111111111"
	workspaceID := "22222222-2222-2222-2222-222222222222"

	t.Run("requires route user before decoding", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`not-json`))
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		handler.PostSnapshot(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("rejects missing repo context", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{}`))
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.PostSnapshot(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("validates route repository id", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{"repository_id":999,"kind":"console","session_id":"`+sessionID+`","payload":{"ok":true}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.PostSnapshot(rec, req)

		require.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("maps session lookup errors through route error writer", func(t *testing.T) {
		upsertCalled := false
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			getSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
				assert.Equal(t, sessionID, id)
				return db.AgentSession{}, stderrors.New("database offline")
			},
			upsertFn: func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
				upsertCalled = true
				return db.DevtoolsSnapshot{}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{"kind":"console","session_id":"`+sessionID+`","payload":{"ok":true}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.PostSnapshot(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.False(t, upsertCalled)
	})

	t.Run("normalizes workspace id into payload and preserves existing payload workspace", func(t *testing.T) {
		var gotPayload json.RawMessage
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			getSessionFn: func(ctx context.Context, id string) (db.AgentSession, error) {
				return db.AgentSession{ID: id, RepositoryID: 101}, nil
			},
			upsertFn: func(ctx context.Context, arg db.UpsertDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
				gotPayload = arg.Payload
				return db.DevtoolsSnapshot{
					SessionID:    arg.SessionID,
					RepositoryID: arg.RepositoryID,
					Kind:         arg.Kind,
					Payload:      arg.Payload,
					Timestamp:    time.Unix(1, 0).UTC(),
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/devtools/snapshots", strings.NewReader(`{"kind":"file-tree","session_id":"`+sessionID+`","workspace_id":"`+workspaceID+`","payload":{"nodes":[]}}`))
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.PostSnapshot(rec, req)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.JSONEq(t, `{"nodes":[],"workspace_id":"`+workspaceID+`"}`, string(gotPayload))
	})
}

func TestDevtoolsSnapshots_Cov_GetSnapshotsBranches(t *testing.T) {
	sessionID := "11111111-1111-1111-1111-111111111111"
	workspaceID := "22222222-2222-2222-2222-222222222222"

	t.Run("requires authenticated user and repository context", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID, nil)
		req = withRepoContext(req, "alice", "demo")
		rec := httptest.NewRecorder()

		handler.GetSnapshots(rec, req)

		require.Equal(t, http.StatusUnauthorized, rec.Code)

		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID, nil)
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		handler.GetSnapshots(rec, req)

		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})

	t.Run("validates query params before service lookup", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{}}
		for _, target := range []string{
			"/api/repos/alice/demo/devtools/snapshots?session_id=bad",
			"/api/repos/alice/demo/devtools/snapshots?session_id=" + sessionID + "&repository_id=0",
			"/api/repos/alice/demo/devtools/snapshots?session_id=" + sessionID + "&repository_id=999",
			"/api/repos/alice/demo/devtools/snapshots?session_id=" + sessionID + "&workspace_id=not-a-uuid",
			"/api/repos/alice/demo/devtools/snapshots?session_id=" + sessionID + "&kind=unknown",
		} {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req = withRepoContext(req, "alice", "demo")
			req = withAuth(req, 7, "alice")
			rec := httptest.NewRecorder()

			handler.GetSnapshots(rec, req)

			assert.NotEqual(t, http.StatusOK, rec.Code, target)
		}
	})

	t.Run("kind lookup maps not found and workspace mismatch", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			getFn: func(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
				assert.Equal(t, "screenshot", arg.Kind)
				return db.DevtoolsSnapshot{}, pgx.ErrNoRows
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID+"&kind=screenshot", nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.GetSnapshots(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)

		handler = &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			getFn: func(ctx context.Context, arg db.GetDevtoolsSnapshotParams) (db.DevtoolsSnapshot, error) {
				return db.DevtoolsSnapshot{
					SessionID:    sessionID,
					RepositoryID: 101,
					Kind:         "screenshot",
					Payload:      json.RawMessage(`{"workspace_id":"33333333-3333-3333-3333-333333333333"}`),
					Timestamp:    time.Unix(2, 0).UTC(),
				}, nil
			},
		}}
		req = httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID+"&kind=screenshot&workspace_id="+workspaceID, nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec = httptest.NewRecorder()

		handler.GetSnapshots(rec, req)

		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("filters listed snapshots by workspace", func(t *testing.T) {
		handler := &DevtoolsSnapshotsHandler{Enabled: true, Queries: &mockDevtoolsSnapshotRouteQuerier{
			listFn: func(ctx context.Context, arg db.ListDevtoolsSnapshotsBySessionParams) ([]db.DevtoolsSnapshot, error) {
				return []db.DevtoolsSnapshot{
					{SessionID: sessionID, RepositoryID: 101, Kind: "command_output", Payload: json.RawMessage(`{"workspace_id":"` + workspaceID + `","value":1}`), Timestamp: time.Unix(3, 0).UTC()},
					{SessionID: sessionID, RepositoryID: 101, Kind: "file_tree", Payload: json.RawMessage(`{"workspace_id":"33333333-3333-3333-3333-333333333333"}`), Timestamp: time.Unix(4, 0).UTC()},
					{SessionID: sessionID, RepositoryID: 101, Kind: "tool_state", Payload: json.RawMessage(`{"value":3}`), Timestamp: time.Unix(5, 0).UTC()},
				}, nil
			},
		}}
		req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/devtools/snapshots?session_id="+sessionID+"&workspace_id="+workspaceID, nil)
		req = withRepoContext(req, "alice", "demo")
		req = withAuth(req, 7, "alice")
		rec := httptest.NewRecorder()

		handler.GetSnapshots(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		var body devtoolsSnapshotListResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Len(t, body.Snapshots, 1)
		assert.Equal(t, "command_output", body.Snapshots[0].Kind)
		require.NotNil(t, body.Snapshots[0].WorkspaceID)
		assert.Equal(t, workspaceID, *body.Snapshots[0].WorkspaceID)
	})
}

func TestDevtoolsSnapshots_Cov_HelperValidation(t *testing.T) {
	t.Run("kind aliases are normalized", func(t *testing.T) {
		got, apiErr := normalizeDevtoolsSnapshotKind(" network ")
		require.Nil(t, apiErr)
		assert.Equal(t, "tool_state", got)
		got, apiErr = normalizeDevtoolsSnapshotKind("command-output")
		require.Nil(t, apiErr)
		assert.Equal(t, "command_output", got)
		_, apiErr = normalizeDevtoolsSnapshotKind("")
		require.Error(t, apiErr)
	})

	t.Run("uuid and payload helpers reject malformed input", func(t *testing.T) {
		_, apiErr := validateRequiredUUID(" ", "session_id")
		require.Error(t, apiErr)
		bad := "not-a-uuid"
		_, apiErr = validateOptionalUUID(&bad, "workspace_id")
		require.Error(t, apiErr)

		_, apiErr = normalizeDevtoolsSnapshotPayload(json.RawMessage(`[]`), nil)
		require.Error(t, apiErr)
		_, apiErr = normalizeDevtoolsSnapshotPayload(json.RawMessage(`null`), nil)
		require.Error(t, apiErr)
		_, apiErr = normalizeDevtoolsSnapshotPayload(json.RawMessage(`{"blob":"`+strings.Repeat("x", devtoolsSnapshotPayloadMaxBytes)+`"}`), nil)
		require.Error(t, apiErr)
	})

	t.Run("workspace matching handles invalid and blank payload values", func(t *testing.T) {
		workspaceID := "22222222-2222-2222-2222-222222222222"
		assert.Equal(t, workspaceID, *services.DevtoolsSnapshotWorkspaceID(json.RawMessage(`{"workspace_id":" ` + workspaceID + ` "}`)))
		assert.Nil(t, services.DevtoolsSnapshotWorkspaceID(json.RawMessage(`{`)))
		assert.Nil(t, services.DevtoolsSnapshotWorkspaceID(json.RawMessage(`{"workspace_id":" "}`)))
		assert.Nil(t, services.DevtoolsSnapshotWorkspaceID(json.RawMessage(`{"value":1}`)))

		assert.Nil(t, queryStringPtr(" "))
		require.NotNil(t, queryStringPtr("  abc  "))
		assert.Equal(t, "abc", *queryStringPtr("  abc  "))
	})
}
