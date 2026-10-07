package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

type webhookAdmissionProbe struct {
	routes.WebhookRouteService
	before  func()
	replace bool
}

func (p *webhookAdmissionProbe) UpdateWebhook(ctx context.Context, actor *db.User, owner, repo string, id int64, input services.UpdateWebhookInput) (db.Webhook, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		v := "https://substituted.example/hook"
		input.URL = &v
	}
	return p.WebhookRouteService.UpdateWebhook(ctx, actor, owner, repo, id, input)
}

func (p *webhookAdmissionProbe) TestWebhook(ctx context.Context, actor *db.User, owner, repo string, id int64) (*services.TestWebhookResult, error) {
	if p.before != nil {
		p.before()
	}
	if p.replace {
		id++
	}
	return p.WebhookRouteService.TestWebhook(ctx, actor, owner, repo, id)
}

func TestInstallWebhookAuthorizationPostgres(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	pool, err := postgresfixture.Open(f.ctx, f.pool.Config().ConnConfig.ConnString(), 1)
	require.NoError(t, err)
	defer pool.Close()
	q := db.New(pool)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Auth.SessionRefreshWindow = "0s"
	cfg.FeatureFlags.WebhooksUser = true
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}

	var sends, mode atomic.Int32
	var expireDuringSend atomic.Bool
	var sendOwnerHash string
	var lastDelivery atomic.Int64
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		if !webhook.VerifyPayloadSignature("private-hook-secret", payload, r.Header.Get("X-Smithers-Signature-256")) {
			t.Error("ping signature did not bind the payload")
		}
		id, err := strconv.ParseInt(r.Header.Get("X-Smithers-Delivery"), 10, 64)
		if err != nil {
			t.Error(err)
			return
		}
		lastDelivery.Store(id)
		// The admission transaction must have committed before this external
		// call, and must not occupy the install's only database connection.
		var reserved bool
		if err := pool.QueryRow(r.Context(), `SELECT status='pending' AND next_retry_at='infinity'::timestamptz AND response_body LIKE '%outcomeUnknown%' FROM webhook_deliveries WHERE id=$1`, id).Scan(&reserved); err != nil || !reserved {
			t.Errorf("missing durable single-send receipt: reserved=%v err=%v", reserved, err)
		}
		claimed, err := q.ClaimDueWebhookDeliveries(r.Context(), 100)
		if err != nil {
			t.Error(err)
		}
		for _, row := range claimed {
			if row.ID == id {
				t.Error("delivery worker claimed the in-flight test ping")
			}
		}
		if expireDuringSend.Load() {
			if _, err := pool.Exec(r.Context(), `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, sendOwnerHash); err != nil {
				t.Error(err)
			}
		}
		if mode.Load() == -1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		if mode.Load() == 500 {
			w.WriteHeader(500)
			_, _ = w.Write([]byte("accepted but response failed"))
			return
		}
		w.WriteHeader(204)
	}))
	defer endpoint.Close()
	service := services.NewWebhookService(q, nil, services.WithWebhookInstallAuthorization(pool), services.WithWebhookHTTPClient(endpoint.Client()))
	handler := &routes.WebhookHandler{Service: service}
	router := buildRouterCompat(cfg, q, pool, &routes.RepoHandler{Service: services.NewRepoService(q, nil, "")}, &routes.AuthHandler{}, &routes.UserHandler{}, &routes.SSHKeyHandler{}, &routes.LabelHandler{},
		&routes.OrgHandler{}, &routes.LandingHandler{}, &routes.SearchHandler{Service: &mockRouterSearchService{}}, &routes.IssueHandler{}, nil, &routes.GitSmartHandler{Service: &mockRouterGitService{}},
		nil, nil, nil, nil, nil, nil, handler, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, &routes.WorkspaceHandler{}, nil, nil, nil, nil, nil, nil)
	session := func(user db.User, raw string) string {
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: user.ID, Username: user.Username, SessionKey: hash, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return hash
	}
	ownerCookie, memberCookie := "hook-owner", "hook-member"
	ownerHash := session(f.owner, ownerCookie)
	sendOwnerHash = ownerHash
	session(f.other, memberCookie)
	maintainer, err := q.CreateUser(f.ctx, db.CreateUserParams{Username: "hook-maintainer", LowerUsername: "hook-maintainer"})
	require.NoError(t, err)
	_, err = f.pool.Exec(f.ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'admin')`, f.repoID, maintainer.ID)
	require.NoError(t, err)
	session(maintainer, "hook-maintainer")
	hook, err := q.CreateWebhook(f.ctx, db.CreateWebhookParams{RepositoryID: f.repoID, Url: endpoint.URL, Secret: "private-hook-secret", Events: []string{"push"}, IsActive: true})
	require.NoError(t, err)
	delivery, err := q.CreateWebhookDelivery(f.ctx, db.CreateWebhookDeliveryParams{WebhookID: hook.ID, EventType: "push", Payload: json.RawMessage(`{"private":"delivery-marker"}`), Status: "failed"})
	require.NoError(t, err)
	path := fmt.Sprintf("/%d", hook.ID)
	type request struct {
		method, path, body, command string
		status                      int
	}
	requests := []request{{"GET", "", "", "webhooks.list", 200}, {"GET", path, "", "webhooks.get", 200}, {"GET", path + "/deliveries", "", "webhooks.deliveries", 200}, {"POST", "", `{"url":"https://created.example/hook","secret":"new-secret","events":["push"],"is_active":true}`, "webhooks.create", 201}, {"PATCH", path, `{"is_active":false}`, "webhooks.update", 200}, {"POST", fmt.Sprintf("%s/deliveries/%d/redeliver", path, delivery.ID), "", "webhooks.redeliver", 201}, {"DELETE", path, "", "webhooks.delete", 204}}
	requests = append(requests, request{"POST", path + "/tests", "", "webhooks.test", 200})
	call := func(cookie, bearer string, r request) (*httptest.ResponseRecorder, []string) {
		t.Helper()
		req := httptest.NewRequest(r.method, cfg.Server.PublicURL+"/api/repos/gate-owner/app/hooks"+r.path, strings.NewReader(r.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", cfg.Server.PublicURL)
		req.Header.Set("X-CSRF-Token", "hook-csrf")
		req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "hook-csrf"})
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		var commands []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		return out, commands
	}
	external := f.token(f.owner, "hook-external", "write:repository,via:codex", true)
	app := f.token(f.owner, "hook-app", "write:repository,via:smithers,terminal-session:"+liveAppTurnCredentialFixture(t, f.pool, f.owner.ID)+"/1", true)
	run := f.token(f.owner, "hook-run", "write:repository,"+middleware.LandingWorkspaceScope("11111111-1111-4111-8111-111111111111")+","+middleware.AgentSessionRestrictionScope("hook-run"), true)
	machine := f.token(f.owner, "hook-machine", "write:repository,"+middleware.WorkspaceRestrictionScope("11111111-1111-4111-8111-111111111111"), true)
	for _, actor := range []struct {
		name, cookie, bearer string
		status               int
	}{{"member", memberCookie, "", 403}, {"maintainer", "hook-maintainer", "", 403}, {"app", "", app, 403}, {"external", "", external, 403}, {"run", "", run, 403}, {"machine", "", machine, 403}, {"scope", "", f.token(f.owner, "hook-scope", "read:repository", false), 403}, {"anonymous", "", "", 401}} {
		for _, r := range requests {
			t.Run(actor.name+"/"+r.command, func(t *testing.T) {
				out, commands := call(actor.cookie, actor.bearer, r)
				require.Equal(t, actor.status, out.Code, out.Body.String())
				require.Equal(t, []string{r.command}, commands)
				require.NotContains(t, out.Body.String(), "private-hook-secret")
				require.NotContains(t, out.Body.String(), "delivery-marker")
			})
		}
	}
	count, err := q.CountWebhooksByRepo(f.ctx, f.repoID)
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
	retained, err := q.GetRepoWebhookByOwnerAndRepo(f.ctx, db.GetRepoWebhookByOwnerAndRepoParams{WebhookID: hook.ID, Owner: "gate-owner", Repo: "app"})
	require.NoError(t, err)
	require.True(t, retained.IsActive)
	require.Equal(t, "private-hook-secret", retained.Secret)
	var deliveries int
	require.NoError(t, f.pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_deliveries WHERE webhook_id=$1`, hook.ID).Scan(&deliveries))
	require.Equal(t, 1, deliveries)
	for _, r := range requests[:6] {
		t.Run("owner/"+r.command, func(t *testing.T) {
			out, commands := call(ownerCookie, "", r)
			require.Equal(t, r.status, out.Code, out.Body.String())
			require.Equal(t, []string{r.command}, commands)
			if r.command == "webhooks.list" {
				require.NotContains(t, out.Body.String(), "private-hook-secret")
				require.Contains(t, out.Body.String(), "********")
			}
			if r.command == "webhooks.redeliver" {
				require.Contains(t, out.Body.String(), `"status":"pending"`)
				require.Contains(t, out.Body.String(), "delivery-marker")
			}
		})
	}
	t.Run("actual body binding", func(t *testing.T) {
		handler.Service = &webhookAdmissionProbe{WebhookRouteService: service, replace: true}
		defer func() { handler.Service = service }()
		out, commands := call(ownerCookie, "", requests[4])
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.update"}, commands)
		stored, err := q.GetRepoWebhookByOwnerAndRepo(f.ctx, db.GetRepoWebhookByOwnerAndRepoParams{WebhookID: hook.ID, Owner: "gate-owner", Repo: "app"})
		require.NoError(t, err)
		require.Equal(t, endpoint.URL, stored.Url)
	})
	t.Run("expiry between admission and service", func(t *testing.T) {
		handler.Service = &webhookAdmissionProbe{WebhookRouteService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}}
		defer func() {
			handler.Service = service
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		out, commands := call(ownerCookie, "", requests[4])
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.update"}, commands)
	})
	t.Run("direct service needs a credential", func(t *testing.T) {
		_, err := service.GetWebhook(f.ctx, &f.owner, "gate-owner", "app", hook.ID)
		var refusal *services.AccessError
		require.ErrorAs(t, err, &refusal)
		require.Equal(t, 401, refusal.Status)
	})
	t.Run("invalid update is atomic", func(t *testing.T) {
		r := requests[4]
		r.body = `{"url":"http://invalid.example","secret":"replacement"}`
		out, commands := call(ownerCookie, "", r)
		require.Equal(t, 422, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.update"}, commands)
		stored, err := q.GetRepoWebhookByOwnerAndRepo(f.ctx, db.GetRepoWebhookByOwnerAndRepoParams{WebhookID: hook.ID, Owner: "gate-owner", Repo: "app"})
		require.NoError(t, err)
		require.Equal(t, "private-hook-secret", stored.Secret)
	})

	t.Run("direct bound reads reject substituted resource actor and repository", func(t *testing.T) {
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		subject, err := services.InstallWebhookSubject(f.repoID, "webhooks.get", hook.ID, 0, struct{}{})
		require.NoError(t, err)
		decision, err := services.Authorize(ctx, q, "webhooks.get", subject)
		require.NoError(t, err)
		ctx = services.WithInstallAuthorization(ctx, "webhooks.get", decision, subject)
		stored, err := service.GetWebhook(ctx, &f.owner, "gate-owner", "app", hook.ID)
		require.NoError(t, err)
		require.Equal(t, "private-hook-secret", stored.Secret)
		denied := func(err error) {
			var refusal *services.AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, 403, refusal.Status)
		}
		_, err = service.GetWebhook(ctx, &f.owner, "gate-owner", "app", hook.ID+1)
		denied(err)
		_, err = service.GetWebhook(ctx, &f.other, "gate-owner", "app", hook.ID)
		denied(err)
		_, err = service.GetWebhook(ctx, &f.owner, "gate-owner", "absent", hook.ID)
		denied(err)
		_, err = service.ListWebhooks(ctx, &f.owner, "gate-owner", "app")
		denied(err)
		require.Equal(t, []string{"webhooks.get"}, commands)
	})

	t.Run("test admission rejects substitution before sending", func(t *testing.T) {
		before := sends.Load()
		handler.Service = &webhookAdmissionProbe{WebhookRouteService: service, replace: true}
		defer func() { handler.Service = service }()
		out, commands := call(ownerCookie, "", requests[7])
		require.Equal(t, 403, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.test"}, commands)
		require.Equal(t, before, sends.Load())
	})
	t.Run("expired test admission sends nothing", func(t *testing.T) {
		before := sends.Load()
		handler.Service = &webhookAdmissionProbe{WebhookRouteService: service, before: func() {
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}}
		defer func() {
			handler.Service = service
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		out, commands := call(ownerCookie, "", requests[7])
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.test"}, commands)
		require.Equal(t, before, sends.Load())
	})
	for _, tc := range []struct {
		name            string
		mode            int32
		status, outcome string
	}{{"success", 0, "success", ""}, {"server failure", 500, "failed", "outcomeUnknown"}, {"lost response", -1, "failed", "outcomeUnknown"}} {
		t.Run("test ping/"+tc.name, func(t *testing.T) {
			mode.Store(tc.mode)
			before := sends.Load()
			out, commands := call(ownerCookie, "", requests[7])
			require.Equal(t, 200, out.Code, out.Body.String())
			require.Equal(t, []string{"webhooks.test"}, commands)
			require.Equal(t, before+1, sends.Load())
			var result services.TestWebhookResult
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &result))
			require.Equal(t, tc.outcome, result.Outcome)
			var status, body string
			var reserved bool
			require.NoError(t, pool.QueryRow(f.ctx, `SELECT status,response_body,next_retry_at='infinity'::timestamptz FROM webhook_deliveries WHERE id=$1`, lastDelivery.Load()).Scan(&status, &body, &reserved))
			require.Equal(t, tc.status, status)
			require.True(t, reserved)
			if tc.outcome != "" {
				require.Contains(t, body, tc.outcome)
			}
			rows, err := q.ClaimDueWebhookDeliveries(f.ctx, 100)
			require.NoError(t, err)
			for _, row := range rows {
				require.NotEqual(t, lastDelivery.Load(), row.ID)
			}
		})
	}

	t.Run("direct test admission keeps one decision through delivery", func(t *testing.T) {
		mode.Store(0)
		before := sends.Load()
		ctx := middleware.ContextWithAuthInfo(f.ctx, &middleware.AuthInfo{User: &f.owner, SessionHash: ownerHash})
		commands := []string{}
		ctx = services.WithAuthorizationObserver(ctx, func(command string) { commands = append(commands, command) })
		result, err := service.TestWebhook(ctx, &f.owner, "gate-owner", "app", hook.ID)
		require.NoError(t, err)
		require.Equal(t, 204, result.StatusCode)
		require.Equal(t, []string{"webhooks.test"}, commands)
		require.Equal(t, before+1, sends.Load())
	})
	t.Run("expiry during delivery hides output and retains the completed receipt", func(t *testing.T) {
		mode.Store(0)
		expireDuringSend.Store(true)
		before := sends.Load()
		defer func() {
			expireDuringSend.Store(false)
			_, err := f.pool.Exec(f.ctx, `UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE session_key=$1`, ownerHash)
			require.NoError(t, err)
		}()
		out, commands := call(ownerCookie, "", requests[7])
		require.Equal(t, 401, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.test"}, commands)
		require.Equal(t, before+1, sends.Load())
		require.NotContains(t, out.Body.String(), "status_code")
		var status string
		require.NoError(t, pool.QueryRow(f.ctx, `SELECT status FROM webhook_deliveries WHERE id=$1`, lastDelivery.Load()).Scan(&status))
		require.Equal(t, "success", status)
	})
	t.Run("owner deletes", func(t *testing.T) {
		out, commands := call(ownerCookie, "", requests[6])
		require.Equal(t, 204, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.delete"}, commands)
		out, commands = call(ownerCookie, "", requests[1])
		require.Equal(t, 404, out.Code, out.Body.String())
		require.Equal(t, []string{"webhooks.get"}, commands)
	})
}
