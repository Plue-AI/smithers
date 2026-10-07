package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type conflictDoorProvider struct {
	unresolved  []string
	signals     int
	validations int
}

func (p *conflictDoorProvider) UnresolvedPaths(context.Context, services.ConflictValidation) ([]string, error) {
	p.validations++
	return p.unresolved, nil
}
func (p *conflictDoorProvider) AdmitInTx(context.Context, pgx.Tx, flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	panic("unexpected launch")
}
func (p *conflictDoorProvider) SignalInTx(context.Context, pgx.Tx, flowdispatch.SignalRequest) (jobs.RequestReceipt, error) {
	p.signals++
	return jobs.RequestReceipt{}, nil
}

// Real install HTTP/auth/storage, native validator contract fake. This does
// not replace C-J7-03's microVM evidence or enable Resolve in the app.
func TestConflictDoneComposedInstall(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx, q := t.Context(), db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pin-owner", LowerUsername: "pin-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d}`, repo.ID))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: binding}))
	access := []byte(fmt.Sprintf(`{"owner_login":"pin-owner","repository_name":"app","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: access}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	source, digest := strings.Repeat("a", 40), strings.Repeat("b", 64)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "running", Checks: []byte(fmt.Sprintf(`{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"%s"}`, source))})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=1,owner_id=$2,attempt=1,flow_digest=$3,request_run_id='pinned-run',workspace_id='11111111-1111-4111-8111-111111111111',revisions='[{"text":"Original","acceptance":[],"reason":"create"}]',title='Pinned source' WHERE id=$1`, item.ID, owner.ID, digest)
	require.NoError(t, err)
	hash := sha256.Sum256([]byte("pin-cookie"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,'pin-owner',NOW()+interval '1 hour')`, hex.EncodeToString(hash[:]), owner.ID)
	require.NoError(t, err)
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode, cfg.Server.PublicURL, cfg.Server.AllowedOrigins = "selfhost", origin, []string{origin}
	service := services.NewMythicalService(pool, nil)

	provider := &conflictDoorProvider{unresolved: []string{"a.txt"}}
	service.SetLauncher(provider)
	server.Config.Handler = todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	server.Start()
	t.Cleanup(server.Close)
	checks := `{"todo":true,"run_launched":true,"run_attached":true,"flowSource":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","rebase":{"onto":"onto","name":"main"},"waits":[{"id":"conflict-1","kind":"conflict","paths":["a.txt"],"conflict_change":"change","onto_revision":"onto","signal":{"flow":"todo","run":"pinned-run","name":"conflict"}}]}`
	// Bind the fake signal to the same production launch address as the item.
	var bound map[string]any
	require.NoError(t, json.Unmarshal([]byte(checks), &bound))
	signal := bound["waits"].([]any)[0].(map[string]any)["signal"].(map[string]any)
	tenant, principal := fmt.Sprintf("repository:%d", repo.ID), fmt.Sprintf("user:%d", owner.ID)
	signal["scope"] = map[string]any{"tenantId": tenant, "principalId": principal}
	signal["target"] = map[string]any{"tenantId": tenant, "principalId": principal, "workspaceId": "11111111-1111-4111-8111-111111111111", "bindingKind": "mythical-item", "bindingId": fmt.Sprintf("%s", item.ID)}
	encoded, err := json.Marshal(bound)
	require.NoError(t, err)
	checks = string(encoded)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2,integration='{"conflict":{"head":"change","onto":"onto","paths":["a.txt"]}}' WHERE id=$1`, item.ID, checks)
	require.NoError(t, err)
	call := func(t *testing.T, expected int, code string) {
		t.Helper()
		req, err := http.NewRequest("POST", origin+"/api/todos/1/answer", strings.NewReader(`{"wait":"conflict-1","answer":"done"}`))
		require.NoError(t, err)
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
		req.Header.Set("X-CSRF-Token", "csrf")
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var body map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&body))
		require.Equal(t, expected, res.StatusCode, body)
		if code != "" {
			require.Equal(t, code, body["code"])
		}
	}
	call(t, 503, "conflict_validation_unavailable")
	service.SetConflictValidator(provider)
	// Missing or mismatched attempt providers refuse individually before native
	// inspection or signal admission, with the person's retained wait unchanged.
	for name, update := range map[string]string{
		"run not launched":         `checks=checks-'run_launched'`,
		"run not attached":         `checks=checks-'run_attached'`,
		"workspace":                `workspace_id=''`,
		"digest":                   `flow_digest=NULL`,
		"malformed digest":         `flow_digest='not-a-pin'`,
		"source":                   `checks=checks-'flowSource'`,
		"run":                      `request_run_id=''`,
		"signal":                   `checks=checks #- '{waits,0,signal}'`,
		"stale run":                `checks=jsonb_set(checks,'{waits,0,signal,run}','"another-run"')`,
		"foreign flow":             `checks=jsonb_set(checks,'{waits,0,signal,flow}','"another-flow"')`,
		"missing scope":            `checks=checks #- '{waits,0,signal,scope}'`,
		"foreign tenant":           `checks=jsonb_set(checks,'{waits,0,signal,target,tenantId}','"repository:999"')`,
		"foreign principal":        `checks=jsonb_set(checks,'{waits,0,signal,target,principalId}','"user:999"')`,
		"foreign signal authority": `checks=jsonb_set(jsonb_set(checks,'{waits,0,signal,scope,principalId}','"user:999"'),'{waits,0,signal,target,principalId}','"user:999"')`,
		"foreign workspace":        `checks=jsonb_set(checks,'{waits,0,signal,target,workspaceId}','"another-branch"')`,
		"foreign binding":          `checks=jsonb_set(checks,'{waits,0,signal,target,bindingId}','"another-item"')`,
		"foreign kind":             `checks=jsonb_set(checks,'{waits,0,signal,target,bindingKind}','"browser-flow"')`,
		"signal name":              `checks=jsonb_set(checks,'{waits,0,signal,name}','""')`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := pool.Exec(ctx, "UPDATE mythical_items SET "+update+" WHERE id=$1", item.ID)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			validations := provider.validations
			call(t, 503, "conflict_validation_unavailable")
			require.Equal(t, validations, provider.validations)
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.JSONEq(t, string(before.Checks), string(after.Checks))
			require.JSONEq(t, string(before.Integration), string(after.Integration))
			require.Equal(t, before.CandidateHead, after.CandidateHead)
			require.Zero(t, provider.signals)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET workspace_id='11111111-1111-4111-8111-111111111111',flow_digest=$2,request_run_id='pinned-run',checks=$3 WHERE id=$1`, item.ID, digest, checks)
			require.NoError(t, err)
		})
	}
	call(t, 409, "still_conflicted")
	retained, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.JSONEq(t, checks, string(retained.Checks))
	require.Zero(t, provider.signals)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{rebase,onto}','"new-target"') WHERE id=$1`, item.ID)
	require.NoError(t, err)
	call(t, 409, "stale_conflict")
	require.Zero(t, provider.signals)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, checks)
	require.NoError(t, err)
	provider.unresolved = nil
	call(t, 202, "")
	call(t, 202, "")
	require.Equal(t, 1, provider.signals)
	// Both branch doors are mounted and authorized, but the install has no
	// native conflict/recovery provider. Neither request admits any rewrite.
	tokens := map[string]string{}
	for _, kind := range []string{"run", "machine"} {
		raw := "smithers_" + strings.Repeat("a", 40)
		if kind == "machine" {
			raw = "smithers_" + strings.Repeat("b", 40)
		}
		sum := sha256.Sum256([]byte(raw))
		digest := hex.EncodeToString(sum[:])
		scopes := "write:repository," + middleware.RepositoryRestrictionScope(repo.ID)
		if kind == "machine" {
			scopes += "," + middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111")
		}
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: kind, TokenHash: digest, TokenLastEight: digest[len(digest)-8:], Scopes: scopes, SystemIssued: true})
		require.NoError(t, err)
		tokens[kind] = raw
	}
	for _, tc := range []struct {
		body      string
		malformed bool
	}{
		{`{"rebase":true}`, false},
		{`{"op":"rebase"}`, false},
		{`{"conflict_change":"change","onto_revision":"onto"}`, false},
		{`{"op":"rebase","conflict_change":"change","onto_revision":"onto"}`, false},
		{`{"op":"rebase","conflict_change":"","onto_revision":""}`, true},
		{`{"op":"rebase","conflict_change":null,"onto_revision":null}`, true},
		{`{"op":"rebase","conflict_change":null}`, true},
	} {
		for _, principal := range []string{"person", "anonymous", "run", "machine"} {
			if tc.malformed && principal != "person" {
				continue
			}
			request, err := http.NewRequest("POST", origin+"/api/branches/scratch%2Fben%2Fwork", strings.NewReader(tc.body))
			require.NoError(t, err)
			if principal == "person" {
				request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "pin-cookie"})
			}
			if token := tokens[principal]; token != "" {
				request.Header.Set("Authorization", "Bearer "+token)
			}
			request.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
			request.Header.Set("X-CSRF-Token", "csrf")
			request.Header.Set("Origin", origin)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "same-press")
			response, err := http.DefaultClient.Do(request)
			require.NoError(t, err)
			var result map[string]any
			require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
			response.Body.Close()
			if tc.malformed {
				require.Equal(t, 400, response.StatusCode, result)
				require.Equal(t, "bad_request", result["code"])
			} else if principal == "person" {
				require.Equal(t, 503, response.StatusCode, result)
				require.Equal(t, "rebase_execution_unavailable", result["code"])
			} else if principal == "anonymous" {
				require.Equal(t, 401, response.StatusCode, result)
			} else {
				require.Equal(t, 403, response.StatusCode, result)
				require.Equal(t, "permission", result["code"])
			}
		}
	}
	require.Equal(t, 1, provider.signals)
}
