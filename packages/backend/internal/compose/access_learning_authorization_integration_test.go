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
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Every admitted cell uses the installed confirmation and proposal consumers,
// production credential issuers and local GitHub server. No customer writes.
func TestAccessLearningProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed Learning effects require PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_LEARNING_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_LEARNING_PROFILES", "C-ACC-02", "learning-profiles-")
	require.True(t, r.install("Learning profiles"))
	benJar, err := r.member("ben", 208, "admin")
	require.NoError(t, err)
	aliceJar, err := r.member("alice", 209, "write")
	require.NoError(t, err)
	q, ctx := db.New(r.pool), r.ctx
	issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
	issuer.Members = &services.Members{Pool: r.pool}
	type actor struct {
		name, cookie, token, profile string
		member                       int64
		role                         int
	}
	var actors []actor
	people := map[int64]actor{}
	origin, err := url.Parse(r.origin)
	require.NoError(t, err)
	cookieName := "smithers_session"
	for role, jar := range []http.CookieJar{r.jar, benJar, aliceJar} {
		login := []string{"rehearsal-owner", "ben", "alice"}[role]
		user, err := q.GetUserByLowerUsername(ctx, login)
		require.NoError(t, err)
		person := actor{name: login + "/session", member: user.ID, role: role}
		for _, cookie := range jar.Cookies(origin) {
			if cookie.Name == "smithers_session" || cookie.Name == "session" {
				person.cookie = cookie.Value
				cookieName = cookie.Name
			}
		}
		require.NotEmpty(t, person.cookie)
		actors = append(actors, person)
		people[user.ID] = person
		for _, via := range []string{"cli", "codex", "claude-code"} {
			raw, err := r.expectAs(jar, "POST", "/api/user/tokens", fmt.Sprintf(`{"name":"matrix-%s","via":%q,"scopes":["repo","user"]}`, via, via), 201)
			require.NoError(t, err)
			var token struct{ Token string }
			require.NoError(t, json.Unmarshal(raw, &token))
			require.NotEmpty(t, token.Token)
			actors = append(actors, actor{name: login + "/external_agent/" + via, member: user.ID, token: token.Token, role: role})
		}
		token, err := issuer.MintForTurn(ctx, user.ID, liveAppTurnCredentialFixture(t, r.pool, user.ID), 1)
		require.NoError(t, err)
		actors = append(actors, actor{name: login + "/app_agent", member: user.ID, token: token.Token, role: role})
	}

	repo, err := q.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: "rehearsal-owner", LowerName: "app"})
	require.NoError(t, err)
	for _, person := range []actor{actors[0], actors[5], actors[10]} {
		workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: person.member, Name: "create-terminal-" + person.name, TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: person.member, Cols: 80, Rows: 24})
		require.NoError(t, err)
		token, err := issuer.MintForTerminal(ctx, person.member, repo.ID, workspace.ID, session.ID)
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/terminal_s1", token: token.Token, member: person.member, role: person.role, profile: "terminal_s1"})
		limited, err := issuer.CreateToken(ctx, person.member, services.CreateTokenRequest{Name: "create-read-only", Via: "codex", Scopes: []string{"read:user", "read:repository"}})
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/read-only", token: limited.Token, member: person.member, role: person.role, profile: "read-only"})
	}

	var receipts []map[string]any
	call := func(t *testing.T, a actor, method, path, body, key, command string, status int, decision bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, r.origin+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:50999"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		if a.token != "" {
			req.Header.Set("Authorization", "Bearer "+a.token)
		} else {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: a.cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "matrix"})
			req.Header.Set("X-CSRF-Token", "matrix")
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(c string) { decisions = append(decisions, c) }))
		out := httptest.NewRecorder()
		r.server.Config.Handler.ServeHTTP(out, req)
		require.Equal(t, status, out.Code, out.Body.String())
		if decision {
			require.Equal(t, []string{command}, decisions)
		} else {
			require.Empty(t, decisions)
		}
		receipts = append(receipts, map[string]any{"actor": a.name, "method": method, "path": path, "status": out.Code, "decisions": decisions})
		return out
	}
	counts := func() (int, int) {
		var cards, todos int
		require.NoError(t, r.pool.QueryRow(ctx, "SELECT count(*) FROM approvals").Scan(&cards))
		require.NoError(t, r.pool.QueryRow(ctx, "SELECT count(*) FROM mythical_items").Scan(&todos))
		return cards, todos
	}
	effects, refusals := 0, 0
	ordinal := 0
	for _, a := range actors {
		for _, operation := range []string{"accept", "dismiss"} {
			for _, door := range []string{"implicit", "explicit"} {
				t.Run(a.name+"/"+operation+"/"+door, func(t *testing.T) {
					ordinal++
					id := fmt.Sprintf("matrix-learning-%d", ordinal)
					note := map[string]any{"repository": "rehearsal-owner/app", "run": "learning-matrix", "signature": "check:matrix@review", "title": "Learning " + id, "prompt": "[HOLD access-learning] " + id, "evidence": []string{"Recorded failure"}, "todos": []int{1}}
					raw, err := json.Marshal(note)
					require.NoError(t, err)
					_, err = r.pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,tags_json,status,text,provenance_json,created_at_ms) VALUES($1,'flow',$2,'[]','pending','Evidence',$3,1)`, id, fmt.Sprintf("learning:%d", repo.ID), string(raw))
					require.NoError(t, err)
					beforeCards, beforeTodos := counts()
					command := "learning." + operation
					path := "/api/proposals/" + id + "/" + operation
					body := `{}`
					if door == "explicit" {
						path = "/api/confirmations"
						body = fmt.Sprintf(`{"command":%q,"subject":{"kind":"proposal","ref":%q},"payload":{}}`, command, id)
					}
					eligible := a.profile == "" && (a.token == "" || strings.HasSuffix(a.name, "/app_agent")) && !(a.token == "" && door == "explicit")
					status := 202
					if !eligible {
						status = 403
					}
					decision := true
					if a.token == "" && door == "explicit" || a.profile == "terminal_s1" || a.profile != "" && door == "explicit" {
						decision = false
					}
					out := call(t, a, "POST", path, body, id, command, status, decision)
					if !eligible {
						require.Contains(t, out.Body.String(), `"class":"permission"`)
						cards, todos := counts()
						require.Equal(t, beforeCards, cards)
						require.Equal(t, beforeTodos, todos)
						var state string
						require.NoError(t, r.pool.QueryRow(ctx, "SELECT status FROM memory_notes WHERE id=$1", id).Scan(&state))
						require.Equal(t, "pending", state)
						refusals++
						return
					}
					if a.token != "" {
						var receipt services.ConfirmationReceipt
						require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
						require.NotEmpty(t, receipt.ID)
						cards, todos := counts()
						require.Equal(t, beforeCards+1, cards)
						require.Equal(t, beforeTodos, todos)
						for _, reader := range people {
							if reader.member != a.member {
								call(t, reader, "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "wrong-"+id, command, 403, false)
							}
						}
						call(t, a, "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "agent-"+id, command, 403, false)
						pressKey := "press-" + id
						if phases := os.Getenv("SMITHERS_ACCESS_LEARNING_PHASE_DIR"); phases != "" && a.name == "rehearsal-owner/app_agent" && operation == "accept" && door == "implicit" {
							fmt.Printf("LEARNING_ACCESS_READY %s %s %s %s\n", r.origin, receipt.ID, people[a.member].cookie, id)
							require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(phases, "approved")); return err == nil }, 90*time.Second, 50*time.Millisecond)
							pressKey = "confirmation:" + receipt.ID + ":approved"
						}
						for range 2 {
							call(t, people[a.member], "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, pressKey, command, 200, true)
						}
					}
					call(t, a, "POST", path, body, id, command, 202, true)
					var state string
					var accepted *string
					require.NoError(t, r.pool.QueryRow(ctx, "SELECT status,accepted_todo FROM memory_notes WHERE id=$1", id).Scan(&state, &accepted))
					_, todos := counts()
					if operation == "accept" {
						require.Equal(t, "accepted", state)
						require.NotNil(t, accepted)
						require.Equal(t, beforeTodos+1, todos)
						var title, prompt string
						var owner, created int64
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT title,revisions->0->>'text',owner_id,created_by FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo.ID, *accepted).Scan(&title, &prompt, &owner, &created))
						require.Equal(t, note["title"], title)
						require.Contains(t, prompt, note["prompt"].(string))
						require.Equal(t, a.member, owner)
						require.Equal(t, a.member, created)
					} else {
						require.Equal(t, "rejected", state)
						require.Nil(t, accepted)
						require.Equal(t, beforeTodos, todos)
					}
					effects++
				})
			}
		}
	}
	staleCells := 0
	for _, a := range []actor{actors[4], actors[9], actors[14]} {
		for _, operation := range []string{"accept", "dismiss"} {
			for _, change := range []string{"revision", "resolved"} {
				t.Run("stale/"+a.name+"/"+operation+"/"+change, func(t *testing.T) {
					id := fmt.Sprintf("stale-learning-%d", staleCells)
					raw, _ := json.Marshal(map[string]any{"repository": "rehearsal-owner/app", "run": "learning-matrix", "signature": "check:matrix@review", "title": "Stale " + id, "prompt": "[HOLD access-learning] " + id, "evidence": []string{"Recorded failure"}, "todos": []int{1}})
					_, err := r.pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,tags_json,status,text,provenance_json,created_at_ms) VALUES($1,'flow',$2,'[]','pending','Evidence',$3,1)`, id, fmt.Sprintf("learning:%d", repo.ID), string(raw))
					require.NoError(t, err)
					command := "learning." + operation
					out := call(t, a, "POST", "/api/proposals/"+id+"/"+operation, `{}`, id, command, 202, true)
					var receipt services.ConfirmationReceipt
					require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
					_, before := counts()
					if change == "revision" {
						_, err = r.pool.Exec(ctx, `UPDATE memory_notes SET provenance_json=jsonb_set(provenance_json::jsonb,'{signature}','"changed"')::text WHERE id=$1`, id)
					} else {
						_, err = r.pool.Exec(ctx, `UPDATE memory_notes SET status='rejected' WHERE id=$1`, id)
					}
					require.NoError(t, err)
					call(t, people[a.member], "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "stale-press-"+id, command, 409, true)
					_, after := counts()
					require.Equal(t, before, after)
					var state string
					require.NoError(t, r.pool.QueryRow(ctx, "SELECT state FROM approvals WHERE id=$1", receipt.ID).Scan(&state))
					require.Equal(t, "expired", state)
					staleCells++
				})
			}
		}
	}
	require.Equal(t, 12, staleCells)
	require.Equal(t, 18, effects)
	require.Equal(t, 66, refusals)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "learning-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "production install HTTP, issuers and confirmation consumer", "successful_effect_cells": effects, "refusal_cells": refusals, "stale_subject_cells": staleCells, "cells": receipts, "full_C_ACC_02_complete": false}), 0600))
}
