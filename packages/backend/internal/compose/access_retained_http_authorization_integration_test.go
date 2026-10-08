package compose

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

type retainedHTTPCase struct {
	Command, Method, Path, Door, Delegated string
	Body                                   map[string]any
	System                                 bool
}

// This campaign is intentionally separate from the 58-cell admission ledger.
// It starts the install itself, not a router with empty handlers. The frozen
// HTTP oracle never reads descriptors to decide an expected result.
func TestRetainedCommandHTTPStateEffectsPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed-install PostgreSQL campaign runs in the access integration gate")
	}
	var fixture struct{ Commands []retainedHTTPCase }
	data, err := os.ReadFile("testdata/access/retained-http.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &fixture))
	t.Setenv("SMITHERS_RETAINED_ACCESS_CAMPAIGN", "1")
	r := newRehearsal(t, "SMITHERS_RETAINED_ACCESS_CAMPAIGN", "C-ACC-01", "retained-")
	require.True(t, r.install("Retained commands"))
	benJar, err := r.member("ben", 208, "admin")
	require.NoError(t, err)
	pool, ctx := r.pool, r.ctx
	q := db.New(pool)
	owner, err := q.GetUserByLowerUsername(ctx, "rehearsal-owner")
	require.NoError(t, err)
	ben, err := q.GetUserByLowerUsername(ctx, "ben")
	require.NoError(t, err)
	repo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: owner.Username, LowerName: "app"})
	require.NoError(t, err)
	issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	issuer.Members = &services.Members{Pool: pool}
	type credential struct {
		name, token, cookie string
		user                int64
	}
	var credentials []credential
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	for index, u := range []db.User{owner, ben} {
		jar := r.jar
		if index == 1 {
			jar = benJar
		}
		cookie := ""
		for _, c := range jar.Cookies(origin) {
			if c.Name == "smithers_session" || c.Name == "session" {
				cookie = c.Value
			}
		}
		require.NotEmpty(t, cookie, "OAuth must mint a real browser session")
		credentials = append(credentials, credential{name: u.Username + "/session", cookie: cookie, user: u.ID})
		for _, via := range []string{"cli", "codex"} {
			data, err := r.expectAs(jar, "POST", "/api/user/tokens", fmt.Sprintf(`{"name":"retained-%s","via":"%s","scopes":["repo","user"]}`, via, via), 201)
			require.NoError(t, err)
			var token struct{ Token string }
			require.NoError(t, json.Unmarshal(data, &token))
			require.NotEmpty(t, token.Token)
			credentials = append(credentials, credential{name: u.Username + "/external_agent/" + via, token: token.Token, user: u.ID})
		}
		app, err := issuer.MintForTurn(ctx, u.ID, liveAppTurnCredentialFixture(t, pool, u.ID), 1)
		require.NoError(t, err)
		credentials = append(credentials, credential{name: u.Username + "/app_agent", token: app.Token, user: u.ID})
	}
	limited, err := issuer.CreateToken(ctx, owner.ID, services.CreateTokenRequest{Name: "retained-limited", Via: "codex", Scopes: []string{"read:user", "read:repository"}})
	require.NoError(t, err)
	workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: ben.ID, Name: "retained-system", TargetBookmark: "main", Kind: "container", Status: "running"})
	require.NoError(t, err)
	router := r.server.Config.Handler
	cookieName := "smithers_session"
	for _, c := range r.jar.Cookies(origin) {
		if c.Value == credentials[0].cookie {
			cookieName = c.Name
		}
	}
	// Bootstrap wiki work runs independently. Snapshot command subjects and
	// all non-bootstrap admissions; do not treat guest heartbeats as effects.
	snapshot := func() string {
		t.Helper()
		var result string
		require.NoError(t, pool.QueryRow(ctx, `SELECT jsonb_build_object(
   'members',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM collaborators t),
   'secrets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM repository_secrets t),
   'todos',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM mythical_items t),
   'confirmations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM approvals t),
   'workspaces',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM workspaces t WHERE t.id=$1 OR (t.name NOT LIKE 'mythical wiki %' AND t.name NOT LIKE 'mythical source %' AND t.name NOT LIKE 'flow-load g%')),
   'requests',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM product_job_requests t WHERE t.request_id LIKE 'campaign-%'),
   'workflows',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM workflow_runs t WHERE NOT (t.trigger_event='main' AND t.trigger_ref='mythical'))
  )::text`, workspace.ID).Scan(&result))
		return result
	}
	replacements := strings.NewReplacer("{owner}", "rehearsal-owner", "{repo}", "app", "{n}", "1", "{number}", "1", "{branch}", "sample", "{b}", "sample", "{name}", "CAMPAIGN_SECRET", "{id}", "1", "{run_id}", "1", "{documentId}", "campaign-document", "{pattern}", "main", "{child_id}", "campaign-child", "{operationID}", "campaign-operation", "{port}", "3000", "{delivery_id}", "1")
	var receipts []map[string]any
	// Qualify the canonical catalog door with real admitted effects as well as
	// refusals. The same existing service handles POST and historical PUT.
	for index, cred := range []credential{credentials[0], credentials[4]} {
		jar := r.jar
		if index == 1 {
			jar = benJar
		}
		body, err := r.expectAs(jar, "POST", "/api/secrets", fmt.Sprintf(`{"name":"CANONICAL_POST","value":"person-secret-%d"}`, index), 201)
		require.NoError(t, err)
		require.NotContains(t, string(body), "person-secret")
		require.NotContains(t, string(body), `"value"`)
		var encrypted []byte
		require.NoError(t, pool.QueryRow(ctx, `SELECT value_encrypted FROM repository_secrets WHERE repository_id=$1 AND name='CANONICAL_POST'`, repo.ID).Scan(&encrypted))
		require.NotEqual(t, []byte(fmt.Sprintf("person-secret-%d", index)), encrypted)
		receipts = append(receipts, map[string]any{"command": "secrets.set", "credential": cred.name, "state": "active", "status": 201, "effects": 1, "boundary": "HTTP socket with OAuth browser session"})
	}
	request := func(t *testing.T, c retainedHTTPCase, cred credential, state string, status int, code string) {
		t.Helper()
		body, err := json.Marshal(c.Body)
		require.NoError(t, err)
		path := c.Path
		if c.System {
			path = strings.ReplaceAll(path, "{id}", workspace.ID)
		}
		req := httptest.NewRequest(c.Method, r.origin+replacements.Replace(path), strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.RemoteAddr = "127.0.0.1:50999"
		req.Header.Set("Idempotency-Key", fmt.Sprintf("campaign-%d", len(receipts)))
		// Every request carries forged attribution. Stored kind/via stays decisive.
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		req.Header.Set("Smithers-Profile", "full")
		if cred.token != "" {
			req.Header.Set("Authorization", "Bearer "+cred.token)
		}
		if cred.cookie != "" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: cred.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
			req.Header.Set("X-CSRF-Token", "campaign")
		}
		before := snapshot()
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		if c.Command == "workspace.provider-pool" && cred.token == "" {
			require.JSONEq(t, `{"error":{"message":"Authentication required.","type":"authentication_error"}}`, out.Body.String())
			require.Equal(t, before, snapshot())
			receipts = append(receipts, map[string]any{"command": c.Command, "credential": cred.name, "state": state, "status": 401, "protocol": "model", "effects": 0})
			return
		}
		var envelope struct{ Code, Class, Message string }
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &envelope), out.Body.String())
		require.Equal(t, code, envelope.Code, out.Body.String())
		class := "permission"
		if code == "never" {
			class = "never"
			require.Equal(t, "Only a person can do this", envelope.Message)
		}
		require.Equal(t, class, envelope.Class)
		var fields map[string]any
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &fields))
		for _, key := range []string{"confirmation", "state", "result", "value", "subject"} {
			require.NotContains(t, fields, key, "refusal must not disclose a result")
		}
		if code == "never" {
			require.Len(t, decisions, 1, "eligible forbidden delegation obtains one decision")
		}
		if status == 401 {
			require.Empty(t, decisions, "dead credentials must precede policy")
		} else {
			require.LessOrEqual(t, len(decisions), 1, "one bound decision")
		}
		require.NotContains(t, out.Body.String(), "never-disclose-campaign-secret")
		require.Equal(t, before, snapshot(), "refusal must preserve exact effect rows")
		receipts = append(receipts, map[string]any{"command": c.Command, "credential": cred.name, "state": state, "method": c.Method, "path": c.Path, "status": out.Code, "code": envelope.Code, "class": envelope.Class, "effects": 0, "decisions": decisions})
	}
	httpCommands := 0
	for _, c := range fixture.Commands {
		if c.Method == "" || c.Command == "telemetry.report" || c.Door == "pending:T-CAT-01" {
			continue
		}
		httpCommands++
		t.Run(c.Command+"/unknown", func(t *testing.T) {
			request(t, c, credential{name: "unknown/session", cookie: "unknown-campaign"}, "unknown", 401, "unauthenticated")
		})
		if strings.HasPrefix(c.Path, "/api/repos/") && c.Method != "GET" {
			t.Run(c.Command+"/insufficient-scope", func(t *testing.T) {
				request(t, c, credential{name: "owner/external_agent/read:user", token: limited.Token}, "active", 403, "permission")
			})
		}
		if c.System {
			for _, cred := range credentials[:4] {
				status := 403
				if c.Command == "workspace.provider-pool" && cred.token == "" {
					status = 401
				}
				t.Run(c.Command+"/excluded/"+cred.name, func(t *testing.T) { request(t, c, cred, "active/exact-stored-workspace", status, "permission") })
			}
		}
		if c.Delegated == "never" {
			for _, cred := range credentials[:4] {
				if cred.token == "" {
					continue
				}
				t.Run(c.Command+"/"+cred.name, func(t *testing.T) { request(t, c, cred, "active", 403, "never") })
			}
		}
	}
	// The credentials were minted while Ben was active. Roster death must take
	// priority immediately, before asynchronous physical revocation or policy.
	for _, state := range []string{"suspended", "removed"} {
		if state == "suspended" {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE user_id=$1`, ben.ID)
		} else {
			_, err = pool.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE user_id=$1`, ben.ID)
			require.NoError(t, err)
			req := httptest.NewRequest("DELETE", r.origin+"/api/members/ben", nil)
			req.Header.Set("Origin", r.origin)
			req.RemoteAddr = "127.0.0.1:50999"
			req.AddCookie(&http.Cookie{Name: cookieName, Value: credentials[0].cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "campaign"})
			req.Header.Set("X-CSRF-Token", "campaign")
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			require.Equal(t, 204, out.Code, out.Body.String())
		}
		require.NoError(t, err)
		for _, c := range fixture.Commands {
			if c.Method == "" || c.Command == "telemetry.report" || c.Door == "pending:T-CAT-01" {
				continue
			}
			for _, cred := range credentials[4:] {
				t.Run(c.Command+"/"+state+"/"+cred.name, func(t *testing.T) { request(t, c, cred, state, 401, "unauthenticated") })
			}
		}
	}
	require.Equal(t, 135, httpCommands)
	require.Equal(t, 1407, len(receipts), "every frozen campaign cell must pass")
	if dir := os.Getenv("SMITHERS_ACCESS_LEDGER_DIR"); dir != "" {
		data, err := json.MarshalIndent(map[string]any{"boundary": "production composed install HTTP refusals", "http_commands": httpCommands, "pending_http_commands": []string{"issue.new (T-CAT-01)"}, "public_http_commands": []string{"telemetry.report"}, "app_commands_without_http_door": 196, "cells": receipts, "full_live_effect_matrix_complete": false}, "", "  ")
		require.NoError(t, err)
		require.NoError(t, os.MkdirAll(dir, 0700))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "retained-http-effects.json"), append(data, '\n'), 0600))
	}
	t.Logf("HTTP campaign: %d commands, %d refusal cells, 2 admitted secret effects; full admitted-effect matrix remains separate", httpCommands, len(receipts)-2)
}

// Catalog data is used only to measure coverage; it never supplies outcomes.
// A new descriptor requires an explicit frozen campaign entry.
func TestRetainedCommandHTTPOracleCoverage(t *testing.T) {
	var fixture struct{ Commands []retainedHTTPCase }
	data, err := os.ReadFile("testdata/access/retained-http.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &fixture))
	var catalog struct {
		Operations []struct {
			Name string
			HTTP *struct{ Method, Path string }
		}
	}
	data, err = os.ReadFile("../../../../catalog.mvp.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, &catalog))
	cases := map[string]retainedHTTPCase{}
	for _, c := range fixture.Commands {
		require.NotContains(t, cases, c.Command)
		cases[c.Command] = c
	}
	require.Len(t, cases, len(catalog.Operations))
	for _, operation := range catalog.Operations {
		c, ok := cases[operation.Name]
		require.True(t, ok, "missing literal case for %s", operation.Name)
		if operation.HTTP != nil {
			require.Equal(t, operation.HTTP.Method, c.Method, operation.Name)
			require.Equal(t, operation.HTTP.Path, c.Path, operation.Name)
		} else {
			require.Equal(t, "app", c.Door, operation.Name)
		}
	}
}
