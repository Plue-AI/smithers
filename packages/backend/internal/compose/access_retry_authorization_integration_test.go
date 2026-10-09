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

func TestAccessRetryProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed retry access matrix requires PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_RETRY_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_RETRY_PROFILES", "C-ACC-02", "retry-profiles-")
	require.True(t, r.install("Retry profiles"))
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

	// Hold independent launch outside the observation interval; the production
	// retry transaction, pin selection and durable fact storage remain composed.
	_, err = r.pool.Exec(ctx, `UPDATE mythical_stacks SET state='frozen' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	var receipts []map[string]any
	effectCells, refusalCells := 0, 0
	for _, a := range actors {
		for _, op := range []string{"retry", "retry-current-flow"} {
			for _, ownership := range []string{"own", "other-member"} {
				for _, stop := range []string{"failure", "policy-stop"} {
					t.Run(a.name+"/"+op+"/"+ownership+"/"+stop, func(t *testing.T) {
						holder := a.member
						if ownership == "other-member" {
							holder = actors[0].member
							if holder == a.member {
								holder = actors[5].member
							}
						}
						var number int64
						require.NoError(t, r.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,owner_id,created_by,revisions,checks,paused_at,attempt,flow_digest)
      VALUES($1,'todo','blocked','Retry authority','Retry authority',$2,$2,'[{"text":"Original prompt","acceptance":[]}]','{}',now(),1,$3) RETURNING number`, repo.ID, holder, strings.Repeat("a", 64)).Scan(&number))
						if stop == "policy-stop" {
							_, err = r.pool.Exec(ctx, `UPDATE mythical_items SET checks='{"fault":{"class":"policy","tag":"launch_bound","kind":"stopped"}}' WHERE repository_id=$1 AND number=$2`, repo.ID, number)
							require.NoError(t, err)
						}
						before, err := q.GetMythicalItemByNumber(ctx, repo.ID, number)
						require.NoError(t, err)
						call := func(key string) *httptest.ResponseRecorder {
							req := httptest.NewRequest("POST", r.origin+fmt.Sprintf("/api/todos/%d", number), strings.NewReader(fmt.Sprintf(`{"op":%q}`, op)))
							req.RemoteAddr = "127.0.0.1:50999"
							req.Header.Set("Content-Type", "application/json")
							req.Header.Set("Origin", r.origin)
							req.Header.Set("Idempotency-Key", key)
							req.Header.Set("Smithers-Actor", "person")
							req.Header.Set("Smithers-Profile", "app_agent")
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
							command := "todo." + op
							allowed := a.profile == "" && (op == "retry" || a.token == "" || strings.HasSuffix(a.name, "/app_agent"))
							if allowed {
								require.Equal(t, 202, out.Code, out.Body.String())
							} else {
								require.Equal(t, 403, out.Code, out.Body.String())
								require.Contains(t, out.Body.String(), `"code":"permission"`)
								require.Contains(t, out.Body.String(), `"class":"permission"`)
							}
							if a.profile == "terminal_s1" {
								require.Empty(t, decisions)
							} else {
								require.Equal(t, []string{command}, decisions, "concrete operation obtains one catalog decision")
							}
							receipts = append(receipts, map[string]any{"actor": a.name, "command": command, "ownership": ownership, "stop": stop, "status": out.Code, "decisions": decisions})
							return out
						}
						key := fmt.Sprintf("retry-profile-%d", number)
						out := call(key)
						after, err := q.GetMythicalItemByNumber(ctx, repo.ID, number)
						require.NoError(t, err)
						if out.Code == 403 {
							require.Equal(t, before, after)
							refusalCells++
							return
						}
						require.Equal(t, "queued", after.State)
						require.Equal(t, holder, after.OwnerID.Int64)
						require.Equal(t, before.FlowDigest, after.FlowDigest, "prior attempt pin remains readable")
						var checks struct {
							Retries []struct {
								Request string
								Attempt int
								Pin     *struct {
									ExecutionDigest string `json:"executionDigest"`
								}
							}
						}
						require.NoError(t, json.Unmarshal(after.Checks, &checks))
						require.Len(t, checks.Retries, 1)
						require.Equal(t, key, checks.Retries[0].Request)
						require.Equal(t, 2, checks.Retries[0].Attempt)
						if op == "retry-current-flow" {
							require.NotNil(t, checks.Retries[0].Pin)
						} else {
							require.Nil(t, checks.Retries[0].Pin)
						}
						replay := call(key)
						require.JSONEq(t, out.Body.String(), replay.Body.String())
						afterReplay, err := q.GetMythicalItemByNumber(ctx, repo.ID, number)
						require.NoError(t, err)
						require.Equal(t, after, afterReplay)
						effectCells++
					})
				}
			}
		}
	}
	require.Equal(t, 84, effectCells)
	require.Equal(t, 84, refusalCells)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "retry-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "installed HTTP and production Retry/pin/credential consumers", "successful_effect_cells": effectCells, "refusal_cells": refusalCells, "cells": receipts, "test_passed": !t.Failed(), "guest_execution_qualified": false}), 0600))
}
