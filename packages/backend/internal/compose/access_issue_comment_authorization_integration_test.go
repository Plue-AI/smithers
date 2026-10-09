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

// Every admitted cell uses the installed confirmation consumer, durable worker,
// production credential issuers and local GitHub server. No customer writes.
func TestAccessIssueCommentProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed issue comment effects require PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_ISSUE_COMMENT_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_ISSUE_COMMENT_PROFILES", "C-ACC-02", "comment-profiles-")
	require.True(t, r.install("Issue comment profiles"))
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
		workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: person.member, Name: "comment-terminal-" + person.name, TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: person.member, Cols: 80, Rows: 24})
		require.NoError(t, err)
		token, err := issuer.MintForTerminal(ctx, person.member, repo.ID, workspace.ID, session.ID)
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/terminal_s1", token: token.Token, member: person.member, role: person.role, profile: "terminal_s1"})
		limited, err := issuer.CreateToken(ctx, person.member, services.CreateTokenRequest{Name: "comment-read-only", Via: "codex", Scopes: []string{"read:user", "read:repository"}})
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/read-only", token: limited.Token, member: person.member, role: person.role, profile: "read-only"})
	}

	number := r.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Profile comments", "Body")
	path := fmt.Sprintf("/api/issues/%d/comments", number)
	var receipts []map[string]any
	call := func(t *testing.T, a actor, method, path, body, key string, status int, decision bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, r.origin+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:50999"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		req.Header.Set("Smithers-Profile", "full")
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
			require.Equal(t, []string{"issue.comment"}, decisions)
		} else {
			require.Empty(t, decisions)
		}
		if status == 403 {
			require.Contains(t, out.Body.String(), `"code":"permission"`)
			require.Contains(t, out.Body.String(), `"class":"permission"`)
		}
		receipts = append(receipts, map[string]any{"actor": a.name, "path": path, "status": out.Code, "decisions": decisions})
		return out
	}
	counts := func() (int, int) {
		t.Helper()
		var cards, jobs int
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&cards))
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE operation='install.issue.comment'`).Scan(&jobs))
		return cards, jobs
	}
	comments := func() []string {
		t.Helper()
		issue, ok := r.fake.Issue("rehearsal-owner/app", number)
		require.True(t, ok)
		values := []string{}
		for _, c := range issue.Comments {
			values = append(values, c.Body)
		}
		return values
	}
	effectCells, refusalCells := 0, 0
	for _, a := range actors {
		for _, door := range []string{"implicit", "explicit"} {
			t.Run(a.name+"/"+door, func(t *testing.T) {
				if a.token == "" && door == "explicit" || a.profile != "" {
					beforeCards, beforeJobs := counts()
					beforeComments := comments()
					endpoint, body := path, `{"body":"Refused profile comment"}`
					if door == "explicit" {
						endpoint = "/api/confirmations"
						body = fmt.Sprintf(`{"command":"issue.comment","subject":{"kind":"issue","ref":%q},"payload":{"body":"Refused profile comment"}}`, fmt.Sprint(number))
					}
					call(t, a, "POST", endpoint, body, "refused-"+a.name+door, 403, door == "implicit" && a.profile != "terminal_s1")
					cards, jobs := counts()
					require.Equal(t, beforeCards, cards)
					require.Equal(t, beforeJobs, jobs)
					require.Equal(t, beforeComments, comments())
					refusalCells++
					return
				}
				text := "Profile comment " + a.name + "/" + door
				key := "effect-" + a.name + door
				endpoint, body := path, fmt.Sprintf(`{"body":%q}`, text)
				if door == "explicit" {
					endpoint = "/api/confirmations"
					body = fmt.Sprintf(`{"command":"issue.comment","subject":{"kind":"issue","ref":%q},"payload":{"body":%q}}`, fmt.Sprint(number), text)
				}
				beforeCards, beforeJobs := counts()
				beforeComments := comments()
				out := call(t, a, "POST", endpoint, body, key, 202, true)
				replay := call(t, a, "POST", endpoint, body, key, 202, true)
				var receipt map[string]any
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
				var operation string
				if a.token != "" {
					require.JSONEq(t, out.Body.String(), replay.Body.String())
					id := receipt["confirmation"].(string)
					require.Equal(t, "pending", receipt["state"])
					cards, jobs := counts()
					require.Equal(t, beforeCards+1, cards)
					require.Equal(t, beforeJobs, jobs)
					require.Equal(t, beforeComments, comments())
					for _, reader := range actors {
						if reader.token == "" && reader.member == a.member {
							continue
						}
						for _, verb := range []string{"approve", "deny"} {
							call(t, reader, "POST", "/api/confirmations/"+id+"/"+verb, `{}`, key+reader.name+verb, 403, false)
						}
					}
					call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, key+"-press", 200, true)
					call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, key+"-press", 200, true)
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT payload->'effect'->>'issue_comment' FROM approvals WHERE id=$1`, id).Scan(&operation))
					replay = call(t, a, "POST", endpoint, body, key, 202, true)
					require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, id), replay.Body.String())
				} else {
					operation = receipt["operationId"].(string)
					var again map[string]any
					require.NoError(t, json.Unmarshal(replay.Body.Bytes(), &again))
					require.Equal(t, operation, again["operationId"])
				}
				require.Eventually(t, func() bool {
					var state string
					err := r.pool.QueryRow(ctx, `SELECT state FROM product_job_requests WHERE id=$1`, operation).Scan(&state)
					return err == nil && state == "completed"
				}, 20*time.Second, 20*time.Millisecond, "durable comment must complete")
				actual := comments()
				require.Len(t, actual, len(beforeComments)+1)
				require.Contains(t, actual[len(actual)-1], text)
				login := strings.Split(a.name, "/")[0]
				require.Contains(t, actual[len(actual)-1], "Requested by @"+login)
				cards, jobs := counts()
				require.Equal(t, beforeJobs+1, jobs)
				if a.token == "" {
					require.Equal(t, beforeCards, cards)
				} else {
					require.Equal(t, beforeCards+1, cards)
				}
				effectCells++
			})
		}
	}
	require.Equal(t, 27, effectCells)
	require.Equal(t, 15, refusalCells)
	require.Len(t, comments(), 27)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "issue-comment-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "installed HTTP, production issuers, durable worker and local GitHub", "successful_effect_cells": effectCells, "scope_and_session_create_refusals": refusalCells, "cells": receipts, "test_passed": !t.Failed(), "full_C_ACC_02_complete": false}), 0600))
}
