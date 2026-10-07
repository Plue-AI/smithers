package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	processruntime "github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// A persisted completion represents a previous server's successful fork. The
// install must serve its original receipt without resolving today's moving
// source or starting any machine. Fresh creation has separate git/workspace
// integration evidence; this test specifically exercises reload and HTTP auth.
func TestForkCompletedRequestInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	t.Setenv("SMITHERS_FEATURE_FLAGS_WORKSPACES", "true")
	t.Setenv("SMITHERS_FEATURE_FLAGS_SANDBOXES", "true")
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"ben","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(binding)}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, repo.ID, owner.ID)
	require.NoError(t, err)
	cookie := "scratch-diff-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	input := services.BranchForkInput{From: "main", Name: "retry"}
	original := services.BranchMachineResponse{Name: "scratch/ben/retry", Kind: "scratch", Head: strings.Repeat("2", 40), State: "provisioning",
		Machine: services.WorkspaceResponse{ID: uuid.NewString(), TargetBookmark: "scratch/ben/retry", Status: "starting"}}
	scope := jobs.Scope{TenantID: fmt.Sprint(repo.ID), PrincipalID: "branch-request:" + hex.EncodeToString(hash[:])}
	namespace := uuid.MustParse("8dd896cf-923d-4510-b2c6-f499d9fb47bd")
	id := uuid.NewSHA1(namespace, []byte(scope.TenantID+"\x00"+scope.PrincipalID+"\x00branch.fork\x00completed-fork")).String()
	fact, _ := json.Marshal(map[string]any{"input": input, "branch": original})
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, id, "branch.fork.completed", "completed", fact)
		return err
	}))

	// A prior process committed intent, then died before completion. Changed
	// input must be refused at the install boundary before any source lookup.
	interruptedID := uuid.NewSHA1(namespace, []byte(scope.TenantID+"\x00"+scope.PrincipalID+"\x00branch.fork\x00interrupted-fork")).String()
	intentID := uuid.NewSHA1(namespace, []byte(interruptedID+"\x00intended")).String()
	intent, _ := json.Marshal(map[string]any{"input": input, "ref": "main", "commit": original.Head, "base": original.Head, "pin": "refs/smithers/keep/" + original.Head})
	require.NoError(t, pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, err := jobs.RecordFactInTx(ctx, tx, scope, intentID, "branch.fork.intended", "intended", intent)
		return err
	}))
	runtime, err := processruntime.New(processruntime.Config{Root: t.TempDir(), MaxConcurrent: 2, OutputLimit: 1 << 20})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	counted := &sleepCountRuntime{WorkspaceRuntime: runtime}
	providers := services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), nil)
	handler := startSplitProcess(t, Options{ChatHost: unusedChatHost{}, Workspace: counted, BranchMachines: &providers, FlowHostProductAPIURL: "http://127.0.0.1:4000"})
	call := func(body, session string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/branches", strings.NewReader(body))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "completed-fork")
		request.Header.Set("Origin", "http://127.0.0.1:4000")
		request.Header.Set("X-CSRF-Token", "fork-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "fork-csrf"})
		if session != "" {
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: session})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	for range 2 {
		response := call(`{"from":"main","name":"retry"}`, cookie)
		require.Equal(t, 201, response.Code, response.Body.String())
		var got services.BranchMachineResponse
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &got))
		require.Equal(t, original, got)
	}
	response := call(`{"from":"T2","name":"retry"}`, cookie)
	require.Equal(t, 409, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "idempotency_mismatch")
	for _, body := range []string{`{}`, `{"from":"main"} {"from":"T2"}`, `{"from":"main","replace":true}`, `{"from":"main","request":"spoof"}`} {
		response := call(body, cookie)
		require.Equal(t, 400, response.Code, response.Body.String())
	}
	require.Equal(t, 401, call(`{"from":"main","name":"retry"}`, "").Code)
	interruptedRequest := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/branches", strings.NewReader(`{"from":"T2","name":"retry"}`))
	interruptedRequest.RemoteAddr = "127.0.0.1:12345"
	interruptedRequest.Header.Set("Content-Type", "application/json")
	interruptedRequest.Header.Set("Idempotency-Key", "interrupted-fork")
	interruptedRequest.Header.Set("Origin", "http://127.0.0.1:4000")
	interruptedRequest.Header.Set("X-CSRF-Token", "fork-csrf")
	interruptedRequest.AddCookie(&http.Cookie{Name: "__csrf", Value: "fork-csrf"})
	interruptedRequest.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	interruptedResponse := httptest.NewRecorder()
	handler.ServeHTTP(interruptedResponse, interruptedRequest)
	require.Equal(t, 409, interruptedResponse.Code, interruptedResponse.Body.String())
	require.Contains(t, interruptedResponse.Body.String(), "idempotency_mismatch")

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
	require.Zero(t, count, "replay and malformed requests never start provisioning")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&count))
	require.Equal(t, 1, count)

	// The retained workspace route consumes the same completion as the branch
	// door. Its source stays running, and no replacement machine is created.
	source, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: owner.ID, Name: "main", TargetBookmark: "main", Status: "running"})
	require.NoError(t, err)
	hosted := httptest.NewRequest("POST", "http://127.0.0.1:4000/api/repos/ben/demo/workspaces/"+source.ID+"/fork", strings.NewReader(`{"name":"retry"}`))
	hosted.RemoteAddr = "127.0.0.1:12345"
	hosted.Header.Set("Content-Type", "application/json")
	hosted.Header.Set("Idempotency-Key", "completed-fork")
	hosted.Header.Set("Origin", "http://127.0.0.1:4000")
	hosted.Header.Set("X-CSRF-Token", "fork-csrf")
	hosted.AddCookie(&http.Cookie{Name: "__csrf", Value: "fork-csrf"})
	hosted.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
	hostedResponse := httptest.NewRecorder()
	handler.ServeHTTP(hostedResponse, hosted)
	require.Equal(t, 201, hostedResponse.Code, hostedResponse.Body.String())
	var machine services.WorkspaceResponse
	require.NoError(t, json.Unmarshal(hostedResponse.Body.Bytes(), &machine))
	require.Equal(t, original.Machine, machine)
	changed := hosted.Clone(ctx)
	changed.Body = io.NopCloser(strings.NewReader(`{"name":"different"}`))
	changedResponse := httptest.NewRecorder()
	handler.ServeHTTP(changedResponse, changed)
	require.Equal(t, 409, changedResponse.Code, changedResponse.Body.String())
	require.Contains(t, changedResponse.Body.String(), "idempotency_mismatch")
	retained, err := q.GetWorkspace(ctx, source.ID)
	require.NoError(t, err)
	require.Equal(t, "running", retained.Status)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
	require.Equal(t, 1, count)
	require.Zero(t, counted.starts.Load())
	require.Zero(t, counted.reads.Load())
	// Removing any machine admission provider must refuse the retained door
	// before loading or restarting its source, creating a row, or recording
	// a completion. These requests have fresh keys; none is a replay.
	for _, missing := range []string{"membership", "authorization", "lane", "microvm", "identity"} {
		t.Run("missing-"+missing, func(t *testing.T) {
			t.Setenv("SMITHERS_BLOB_DATA_DIR", t.TempDir())
			removed := providers
			switch missing {
			case "membership":
				removed.Membership = nil
			case "authorization":
				removed.Authorize = nil
			case "lane":
				removed.LaneBinding = nil
			case "microvm":
				removed.MicroVM = nil
			case "identity":
				removed.SessionIdentity = nil
			}
			without := startSplitProcess(t, Options{ChatHost: unusedChatHost{}, Workspace: counted, BranchMachines: &removed, FlowHostProductAPIURL: "http://127.0.0.1:4000"})
			request := hosted.Clone(ctx)
			request.Body = io.NopCloser(strings.NewReader(`{"name":"unavailable"}`))
			request.Header.Set("Idempotency-Key", "missing-"+missing)
			response := httptest.NewRecorder()
			without.ServeHTTP(response, request)
			require.Equal(t, 503, response.Code, response.Body.String())
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM workspaces`).Scan(&count))
			require.Equal(t, 1, count)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='branch.fork.completed'`).Scan(&count))
			require.Equal(t, 1, count)
			require.Zero(t, counted.starts.Load())
			require.Zero(t, counted.reads.Load())
		})
	}

}
