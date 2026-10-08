package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The barrier is the production install write lock, not an authorization hook.
// OAuth sessions and issued tokens cross the fully composed HTTP boundary. SQL
// changes model committed transitions while that lock holds the request back.
func TestAccessConfirmationWriteOrderComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed confirmation write-order matrix requires PostgreSQL")
	}
	t.Setenv("SMITHERS_ACCESS_CONFIRMATION_ORDER", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_CONFIRMATION_ORDER", "C-ACC-02", "confirmation-order-")
	require.True(t, r.install("Confirmation write ordering"))
	q, ctx := db.New(r.pool), r.ctx
	repo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: "rehearsal-owner", LowerName: "app"})
	require.NoError(t, err)
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	type identity struct {
		cookie, cookieName, token string
		user                      int64
	}
	next := int64(300)
	actor := func(t *testing.T, role, via string) identity {
		t.Helper()
		// Each cell models a fresh browser; clear only this isolated database's OAuth limiter between unrelated sign-ins.
		require.NoError(t, q.DeleteAllRateLimits(ctx))
		next++
		login := fmt.Sprintf("order%d", next)
		jar, err := r.member(login, next, role)
		require.NoError(t, err)
		user, err := q.GetUserByLowerUsername(ctx, login)
		require.NoError(t, err)
		a := identity{user: user.ID}
		for _, c := range jar.Cookies(origin) {
			if c.Name == "session" || c.Name == "smithers_session" {
				a.cookie, a.cookieName = c.Value, c.Name
			}
		}
		require.NotEmpty(t, a.cookie)
		raw, err := r.expectAs(jar, "POST", "/api/user/tokens", fmt.Sprintf(`{"name":"confirmation-order","via":%q,"scopes":["repo","user"]}`, map[bool]string{true: "codex", false: via}[via == "smithers"]), 201)
		require.NoError(t, err)
		var issued struct{ Token string }
		require.NoError(t, json.Unmarshal(raw, &issued))
		require.NotEmpty(t, issued.Token)
		a.token = issued.Token
		if via == "smithers" {
			issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
			issuer.Members = &services.Members{Pool: r.pool}
			token, err := issuer.MintForTurn(ctx, user.ID, liveAppTurnCredentialFixture(t, r.pool, user.ID), 1)
			require.NoError(t, err)
			a.token = token.Token
		}
		return a
	}
	type response struct {
		status    int
		body      string
		decisions []string
	}
	call := func(callCtx context.Context, a identity, delegated bool, path, body, key string) response {
		req := httptest.NewRequest("POST", r.origin+path, strings.NewReader(body)).WithContext(callCtx)
		req.RemoteAddr = "127.0.0.1:51900"
		req.Header.Set("Origin", r.origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		if delegated {
			req.Header.Set("Authorization", "Bearer "+a.token)
		} else {
			req.AddCookie(&http.Cookie{Name: a.cookieName, Value: a.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "order"})
			req.Header.Set("X-CSRF-Token", "order")
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		r.server.Config.Handler.ServeHTTP(out, req)
		return response{out.Code, out.Body.String(), decisions}
	}
	body := `{"command":"todo.new","payload":{"title":"[HOLD access-order] Private","prompt":"[HOLD access-order] Private"}}`
	create := func(t *testing.T, a identity, key string) string {
		t.Helper()
		out := call(ctx, a, true, "/api/confirmations", body, key)
		require.Equal(t, 202, out.status, out.body)
		require.Equal(t, []string{"todo.new"}, out.decisions)
		var row map[string]string
		require.NoError(t, json.Unmarshal([]byte(out.body), &row))
		require.Equal(t, "pending", row["state"])
		require.NotEmpty(t, row["confirmation"])
		return row["confirmation"]
	}
	snapshot := func(t *testing.T) string {
		t.Helper()
		var s string
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT jsonb_build_object('cards',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM approvals a),'todos',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM mythical_items i))::text`).Scan(&s))
		return s
	}
	var receipts []map[string]any
	for _, via := range []string{"cli", "codex", "claude-code", "smithers"} {
		for _, role := range []string{"admin", "write"} {
			for _, operation := range []string{"create", "replay", "approve", "deny"} {
				for _, change := range []string{"downgrade", "suspend", "remove", "credential-expiry", "deadline"} {
					if change == "deadline" && operation == "create" {
						continue
					}
					t.Run(via+"/"+role+"/"+operation+"/"+change, func(t *testing.T) {
						a := actor(t, role, via)
						id := ""
						if operation != "create" {
							id = create(t, a, "create")
						}
						path, key, delegated := "/api/confirmations", "create", true
						if operation == "approve" || operation == "deny" {
							path += "/" + id + "/" + operation
							key = "press"
							delegated = false
						}
						requestBody := body
						if !delegated {
							requestBody = `{}`
						}
						lock, err := r.pool.Begin(ctx)
						require.NoError(t, err)
						defer lock.Rollback(context.Background())
						_, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repo.ID)
						require.NoError(t, err)
						requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
						defer cancel()
						done := make(chan response, 1)
						go func() { done <- call(requestCtx, a, delegated, path, requestBody, key) }()
						require.Eventually(t, func() bool {
							var n int
							err := r.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock($1)'`).Scan(&n)
							return err == nil && n >= 1
						}, 5*time.Second, 10*time.Millisecond, "HTTP request must reach the production serialization barrier")
						status, code := 401, "unauthenticated"
						switch change {
						case "downgrade":
							_, err = r.pool.Exec(ctx, `UPDATE collaborators SET permission='read' WHERE repository_id=$1 AND user_id=$2`, repo.ID, a.user)
							status, code = 401, "unauthenticated"
						case "suspend":
							_, err = r.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, a.user)
						case "remove":
							_, err = r.pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo.ID, a.user)
						case "credential-expiry":
							raw := a.cookie
							if delegated {
								raw = a.token
							}
							sum := sha256.Sum256([]byte(raw))
							hash := hex.EncodeToString(sum[:])
							if delegated {
								_, err = r.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hash)
							} else {
								_, err = r.pool.Exec(ctx, `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE session_key=$1`, hash)
							}
						case "deadline":
							_, err = r.pool.Exec(ctx, `UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1`, id)
							status, code = 409, "confirmation_resolved"
						}
						require.NoError(t, err)
						before := snapshot(t)
						require.NoError(t, lock.Commit(ctx))
						var out response
						select {
						case out = <-done:
						case <-time.After(15 * time.Second):
							t.Fatal("queued HTTP request did not finish")
						}
						// A create replay reports current expiry without execution or disclosure of
						// the private payload; an expired press refuses and settles only the card.
						if change == "deadline" && operation == "replay" {
							status, code = 202, ""
						}
						require.Equal(t, status, out.status, out.body)
						if code != "" {
							require.Contains(t, out.body, `"code":"`+code+`"`)
							require.Contains(t, out.body, `"class":"`+map[bool]string{true: "conflict", false: "permission"}[status == 409]+`"`)
						}
						if status == 401 {
							require.Empty(t, out.decisions)
							if id != "" {
								require.NotContains(t, out.body, id)
							}
						} else {
							require.Equal(t, []string{"todo.new"}, out.decisions)
						}
						if change == "deadline" {
							var state string
							require.NoError(t, r.pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, id).Scan(&state))
							require.Equal(t, "expired", state)
							if operation == "replay" {
								require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"expired"}`, id), out.body)
							}
						} else {
							require.Equal(t, before, snapshot(t), "refusal cannot change a card or execute its action")
						}
						var n int
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&n))
						require.Zero(t, n)
						receipts = append(receipts, map[string]any{"profile": via, "role": role, "operation": operation, "transition": change, "order": "transition-before-write", "status": out.status, "decisions": out.decisions, "todo_effects": 0})
					})
				}
			}
		}
	}
	require.Len(t, receipts, 152)
	// The opposite order permits the committed action. A later member removal
	// cannot erase it, and replay must authenticate before disclosing its result.
	for _, via := range []string{"cli", "codex", "claude-code", "smithers"} {
		for _, role := range []string{"admin", "write"} {
			for _, operation := range []string{"approve", "deny"} {
				t.Run(via+"/"+role+"/"+operation+"/write-before-remove", func(t *testing.T) {
					a := actor(t, role, via)
					id := create(t, a, "write-first")
					path := "/api/confirmations/" + id + "/" + operation
					// Concurrent duplicate presses take the same production lock and
					// durable operation key, so only one underlying action commits.
					pressed := make(chan response, 2)
					for range 2 {
						go func() { pressed <- call(ctx, a, false, path, `{}`, "write-first-press") }()
					}
					out := <-pressed
					duplicate := <-pressed
					require.Equal(t, 200, duplicate.status, duplicate.body)
					require.Equal(t, []string{"todo.new"}, duplicate.decisions)
					require.JSONEq(t, out.body, duplicate.body)
					require.Equal(t, 200, out.status, out.body)
					require.Equal(t, []string{"todo.new"}, out.decisions)
					state := "rejected"
					if operation == "approve" {
						state = "approved"
					}
					require.JSONEq(t, fmt.Sprintf(`{"id":%q,"state":%q}`, id, state), out.body)
					again := call(ctx, a, false, path, `{}`, "write-first-press")
					require.Equal(t, 200, again.status, again.body)
					require.Equal(t, []string{"todo.new"}, again.decisions)
					require.JSONEq(t, out.body, again.body)
					if operation == "approve" {
						var number int64
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT number FROM mythical_items WHERE created_by=$1`, a.user).Scan(&number))
						_, err := r.expect("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, 202)
						require.NoError(t, err)
					}
					user, err := q.GetUserByID(ctx, a.user)
					require.NoError(t, err)
					secondJar, err := r.member(user.Username, next, role)
					require.NoError(t, err)
					second := a
					for _, c := range secondJar.Cookies(origin) {
						if c.Name == a.cookieName {
							second.cookie = c.Value
						}
					}
					require.NotEqual(t, a.cookie, second.cookie)
					otherSession := call(ctx, second, false, path, `{}`, "write-first-press")
					require.Equal(t, 409, otherSession.status, otherSession.body)
					require.Contains(t, otherSession.body, `"code":"confirmation_resolved"`)
					require.Equal(t, []string{"todo.new"}, otherSession.decisions)
					_, err = r.expect("DELETE", "/api/members/"+user.Username, "", 204)
					require.NoError(t, err)
					before := snapshot(t)
					dead := call(ctx, a, false, path, `{}`, "write-first-press")
					require.Equal(t, 401, dead.status, dead.body)
					require.Contains(t, dead.body, `"code":"unauthenticated"`)
					require.Empty(t, dead.decisions)
					require.NotContains(t, dead.body, id)
					require.Equal(t, before, snapshot(t))
					var current string
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, id).Scan(&current))
					require.Equal(t, state, current)
					receipts = append(receipts, map[string]any{"profile": via, "role": role, "operation": operation, "transition": "remove", "order": "write-before-transition", "status": out.status, "replay_after_removal": dead.status, "todo_effects": map[bool]int{true: 1, false: 0}[operation == "approve"]})
				})
			}
		}
	}
	require.Len(t, receipts, 168)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "confirmation-write-order.json"), accessProfilesJSON(t, map[string]any{"boundary": "composed install HTTP and production write lock", "cells": receipts, "full_C_ACC_02_complete": false}), 0600))
}
