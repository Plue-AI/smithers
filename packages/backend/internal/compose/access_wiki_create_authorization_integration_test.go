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

func TestAccessWikiCreateProfilesComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed wiki create matrix requires PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_WIKI_CREATE_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_WIKI_CREATE_PROFILES", "C-ACC-02", "wiki-create-profiles-")
	require.True(t, r.install("Wiki create profiles"))
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
	index, effects, refusals, staleCells := 0, 0, 0, 0
	for _, a := range actors {
		for _, door := range []string{"implicit", "explicit"} {
			for _, visibility := range []string{"public", "private"} {
				t.Run(a.name+"/"+door+"/"+visibility, func(t *testing.T) {
					index++
					slug := fmt.Sprintf("access-create-%d", index)
					base := "/api/repos/rehearsal-owner/app/wiki"
					suffix := "?visibility=" + visibility
					pagePath := base + "/" + slug + suffix
					page := fmt.Sprintf(`{"slug":%q,"title":%q,"body":"Keep these exact bytes"}`, slug, "Wiki create "+slug)
					payload, endpoint := page, base+suffix
					if door == "explicit" {
						payload, endpoint = fmt.Sprintf(`{"command":"wiki.create","subject":{"kind":"wiki","ref":%q},"payload":{"owner":"rehearsal-owner","repo":"app","visibility":%q,"page":%s}}`, slug, visibility, page), "/api/confirmations"
					}
					allowed := a.profile == "" && (a.token == "" && door == "implicit" || strings.HasSuffix(a.name, "/app_agent"))
					status, decision := 403, "wiki.create"
					if allowed {
						status = 202
						if a.token == "" {
							status = 201
						}
					}
					if door == "explicit" && (a.token == "" || a.profile != "") || door == "implicit" && a.profile == "terminal_s1" {
						decision = ""
					}
					var beforeCards int
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&beforeCards))
					out := call(t, a, "POST", endpoint, payload, slug, decision, status)
					count := func() int {
						var n int
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1 AND slug=$2 AND visibility=$3`, repo.ID, slug, visibility).Scan(&n))
						return n
					}
					if !allowed {
						require.Zero(t, count())
						var cards int
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&cards))
						require.Equal(t, beforeCards, cards)
						refusals++
						return
					}
					if a.token != "" {
						require.Zero(t, count())
						var receipt services.ConfirmationReceipt
						require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
						require.NotEmpty(t, receipt.ID)
						id := receipt.ID
						replay := call(t, a, "POST", endpoint, payload, slug, "wiki.create", 202)
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
						if phases := os.Getenv("SMITHERS_ACCESS_WIKI_CREATE_PHASE_DIR"); phases != "" && a.name == "rehearsal-owner/app_agent" && door == "implicit" && visibility == "public" {
							pressKey = "confirmation:" + id + ":approved"
							fmt.Printf("WIKI_CREATE_READY %s %s %s %s\n", r.origin, id, people[a.member].cookie, pagePath)
							require.Eventually(t, func() bool { _, err := os.Stat(filepath.Join(phases, "approved")); return err == nil }, 90*time.Second, 50*time.Millisecond)
						}
						for range 2 {
							call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, pressKey, "wiki.create", 200)
						}
						replay = call(t, a, "POST", endpoint, payload, slug, "wiki.create", 202)
						require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, id), replay.Body.String())
					}
					require.Equal(t, 1, count())
					stored, err := q.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repo.ID, Slug: slug, Visibility: visibility})
					require.NoError(t, err)
					require.Equal(t, "Keep these exact bytes", stored.Body)
					require.Equal(t, a.member, stored.AuthorID)
					call(t, people[a.member], "DELETE", pagePath, "", slug+"-cleanup", "wiki.delete", 204)
					if a.token != "" {
						fresh := call(t, a, "POST", endpoint, payload, slug+"-stale", "wiki.create", 202)
						var receipt services.ConfirmationReceipt
						require.NoError(t, json.Unmarshal(fresh.Body.Bytes(), &receipt))
						// Another member occupies either the slug or its case-insensitive path.
						other := people[actors[0].member]
						if other.member == a.member {
							other = people[actors[5].member]
						}
						replacement := page
						if door == "explicit" {
							replacement = fmt.Sprintf(`{"slug":%q,"path":%q,"title":"Other page","body":"Other bytes"}`, slug+"-other", strings.ToUpper(slug)+".md")
						}
						call(t, other, "POST", base+suffix, replacement, slug+"-occupy", "wiki.create", 201)
						refused := call(t, people[a.member], "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, slug+"-stale-press", "wiki.create", 409)
						require.Contains(t, refused.Body.String(), `"code":"confirmation_resolved"`)
						replay := call(t, a, "POST", endpoint, payload, slug+"-stale", "wiki.create", 202)
						require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"expired"}`, receipt.ID), replay.Body.String())
						staleCells++
					}
					effects++
				})
			}
		}
	}
	t.Run("validation canonical title and denied creation", func(t *testing.T) {
		a := actors[4]
		base := "/api/repos/rehearsal-owner/app/wiki"
		for i, payload := range []string{`{"title":""}`, `{"title":"Invalid","path":"../private.md"}`, `{"title":"Invalid","slug":"!!!"}`, `{"title":"Invalid","body":"\u0000"}`} {
			var before, after int
			require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&before))
			status := 400
			if i == 0 || i == 2 {
				status = 422
			}
			// Service validation returns the same typed HTTP envelope as a person create.
			person := call(t, people[a.member], "POST", base, payload, fmt.Sprintf("invalid-person-%d", i), "wiki.create", status)
			delegated := call(t, a, "POST", base, payload, fmt.Sprintf("invalid-app-%d", i), "wiki.create", status)
			require.JSONEq(t, person.Body.String(), delegated.Body.String())
			require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&after))
			require.Equal(t, before, after)
		}
		payload := `{"title":"Derived Slug","body":"Never published"}`
		requested := call(t, a, "POST", base, payload, "create-denied", "wiki.create", 202)
		var receipt services.ConfirmationReceipt
		require.NoError(t, json.Unmarshal(requested.Body.Bytes(), &receipt))
		mismatch := call(t, a, "POST", base, `{"title":"Derived Slug","body":"Different bytes"}`, "create-denied", "wiki.create", 409)
		require.Contains(t, mismatch.Body.String(), `"code":"idempotency_mismatch"`)
		for range 2 {
			call(t, people[a.member], "POST", "/api/confirmations/"+receipt.ID+"/deny", `{}`, "create-deny-press", "wiki.create", 200)
		}
		replay := call(t, a, "POST", base, payload, "create-denied", "wiki.create", 202)
		require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"rejected"}`, receipt.ID), replay.Body.String())
		var pages int
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE repository_id=$1 AND slug='derived-slug'`, repo.ID).Scan(&pages))
		require.Zero(t, pages)
		requested = call(t, a, "POST", base, payload, "create-title-only", "wiki.create", 202)
		require.NoError(t, json.Unmarshal(requested.Body.Bytes(), &receipt))
		call(t, people[a.member], "POST", "/api/confirmations/"+receipt.ID+"/approve", `{}`, "create-title-only-press", "wiki.create", 200)
		stored, err := q.GetWikiPageBySlug(ctx, db.GetWikiPageBySlugParams{RepositoryID: repo.ID, Slug: "derived-slug", Visibility: "public"})
		require.NoError(t, err)
		require.Equal(t, "Never published", stored.Body)
		require.Equal(t, "derived-slug.md", stored.Path)
	})
	require.Equal(t, 18, effects)
	require.Equal(t, 66, refusals)
	require.Equal(t, 12, staleCells)
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "wiki-create-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "installed HTTP, real page creation and production confirmation consumer", "successful_effect_cells": effects, "refusal_cells": refusals, "stale_cells": staleCells, "cells": receipts, "test_passed": !t.Failed(), "full_C_ACC_02_complete": false}), 0600))
}
