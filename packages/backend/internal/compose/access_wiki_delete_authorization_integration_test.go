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

func TestAccessWikiDeleteProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed wiki delete matrix requires PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_WIKI_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_WIKI_PROFILES", "C-ACC-02", "wiki-profiles-")
	require.True(t, r.install("Wiki delete profiles"))
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

	var receipts []map[string]any
	call := func(t *testing.T, a actor, method, path, body, key, decision string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, r.origin+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:50999"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", r.origin)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "smithers")
		req.Header.Set("Smithers-Profile", "app_agent")
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
		if decision == "" {
			require.Empty(t, decisions)
		} else {
			require.Equal(t, []string{decision}, decisions)
		}
		if status == 403 {
			require.Contains(t, out.Body.String(), `"code":"permission"`)
			require.Contains(t, out.Body.String(), `"class":"permission"`)
		}
		receipts = append(receipts, map[string]any{"actor": a.name, "method": method, "path": path, "status": out.Code, "decisions": decisions})
		return out
	}
	pageIndex, effects, refusals, staleCells := 0, 0, 0, 0
	for _, a := range actors {
		for _, door := range []string{"implicit", "explicit"} {
			for _, visibility := range []string{"public", "private"} {
				for _, ownership := range []string{"own", "other-member"} {
					t.Run(a.name+"/"+door+"/"+visibility+"/"+ownership, func(t *testing.T) {
						creator := people[a.member]
						if ownership == "other-member" {
							creator = people[actors[0].member]
							if creator.member == a.member {
								creator = people[actors[5].member]
							}
						}
						pageIndex++
						slug := fmt.Sprintf("access-delete-%d", pageIndex)
						base := "/api/repos/rehearsal-owner/app/wiki"
						suffix := "?visibility=" + visibility
						pagePath := base + "/" + slug + suffix
						call(t, creator, "POST", base+suffix, fmt.Sprintf(`{"slug":%q,"title":%q,"body":"Keep these exact bytes"}`, slug, "Wiki delete "+slug), slug+"-create", "wiki.create", 201)
						page, err := q.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repo.ID, Slug: slug, Visibility: visibility})
						require.NoError(t, err)
						method, endpoint, payload := "DELETE", pagePath, ""
						if door == "explicit" {
							method, endpoint, payload = "POST", "/api/confirmations", fmt.Sprintf(`{"command":"wiki.delete","subject":{"kind":"wiki","ref":%q},"payload":{"owner":"rehearsal-owner","repo":"app","visibility":%q}}`, slug, visibility)
						}
						allowed := a.profile == "" && (a.token == "" && door == "implicit" || strings.HasSuffix(a.name, "/app_agent"))
						status, decision := 403, "wiki.delete"
						if allowed {
							status = 202
							if a.token == "" {
								status = 204
							}
						}
						if door == "explicit" && (a.token == "" || a.profile != "") || door == "implicit" && a.profile == "terminal_s1" {
							decision = ""
						}
						var beforeCards int
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&beforeCards))
						out := call(t, a, method, endpoint, payload, slug, decision, status)
						count := func() int {
							var n int
							require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE id=$1`, page.ID).Scan(&n))
							return n
						}
						if !allowed {
							after, err := q.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repo.ID, Slug: slug, Visibility: visibility})
							require.NoError(t, err)
							require.Equal(t, page, after)
							var cards int
							require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&cards))
							require.Equal(t, beforeCards, cards)
							call(t, creator, "DELETE", pagePath, "", slug+"-cleanup", "wiki.delete", 204)
							refusals++
							return
						}
						if a.token != "" {
							require.Equal(t, 1, count())
							var card map[string]string
							require.NoError(t, json.Unmarshal(out.Body.Bytes(), &card))
							require.Equal(t, "pending", card["state"])
							id := card["confirmation"]
							require.NotEmpty(t, id)
							replay := call(t, a, method, endpoint, payload, slug, "wiki.delete", 202)
							require.JSONEq(t, out.Body.String(), replay.Body.String())
							var cards int
							require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&cards))
							require.Equal(t, beforeCards+1, cards)
							for _, reader := range []actor{a, people[actors[0].member], people[actors[5].member], people[actors[10].member]} {
								if reader.token == "" && reader.member == a.member {
									continue
								}
								for _, verb := range []string{"approve", "deny"} {
									call(t, reader, "POST", "/api/confirmations/"+id+"/"+verb, `{}`, slug+reader.name+verb, "", 403)
								}
							}
							pressKey := slug + "-press"
							if phases := os.Getenv("SMITHERS_ACCESS_WIKI_PHASE_DIR"); phases != "" && a.name == "rehearsal-owner/app_agent" && door == "implicit" && visibility == "public" && ownership == "own" {
								pressKey = "confirmation:" + id + ":approved"
								fmt.Printf("WIKI_DELETE_READY %s %s %s %s\n", r.origin, id, people[a.member].cookie, pagePath)
								require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(phases, "approved")); return err == nil }, 90*time.Second, 50*time.Millisecond, "browser must press its private Wiki Delete card")
							}
							call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, pressKey, "wiki.delete", 200)
							call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, pressKey, "wiki.delete", 200)
							require.Zero(t, count())
							replay = call(t, a, method, endpoint, payload, slug, "wiki.delete", 202)
							require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, id), replay.Body.String())
							// Recreate and change the revision through the real page editor. A
							// fresh card must expire rather than delete the edited page.
							call(t, creator, "POST", base+suffix, fmt.Sprintf(`{"slug":%q,"title":"Replacement","body":"Replacement bytes"}`, slug), slug+"-replacement", "wiki.create", 201)
							fresh := call(t, a, method, endpoint, payload, slug+"-stale", "wiki.delete", 202)
							require.NoError(t, json.Unmarshal(fresh.Body.Bytes(), &card))
							id = card["confirmation"]
							call(t, creator, "PATCH", pagePath, `{"body":"Edited replacement bytes","expected_revision":1}`, slug+"-edit", "wiki.edit", 200)
							refused := call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, slug+"-stale-press", "wiki.delete", 409)
							require.Contains(t, refused.Body.String(), `"code":"confirmation_resolved"`)
							replay = call(t, a, method, endpoint, payload, slug+"-stale", "wiki.delete", 202)
							require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"expired"}`, id), replay.Body.String())
							edited, err := q.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repo.ID, Slug: slug, Visibility: visibility})
							require.NoError(t, err)
							require.Equal(t, "Edited replacement bytes", edited.Body)
							require.EqualValues(t, 2, edited.Revision)
							call(t, creator, "DELETE", pagePath, "", slug+"-cleanup", "wiki.delete", 204)
							staleCells++
						} else {
							require.Zero(t, count())
						}
						effects++
					})
				}
			}
		}
	}
	require.Equal(t, 36, effects)
	require.Equal(t, 132, refusals)
	require.Equal(t, 24, staleCells)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "wiki-delete-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "installed HTTP, real page editor/delete and production confirmation consumer", "successful_effect_cells": effects, "scope_actor_and_session_create_refusals": refusals, "stale_revision_cells": staleCells, "cells": receipts, "test_passed": !t.Failed(), "full_C_ACC_02_complete": false}), 0600))
}
