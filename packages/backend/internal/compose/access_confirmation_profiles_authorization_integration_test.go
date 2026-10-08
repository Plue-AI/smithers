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

// This supplements the retained-effect campaign with literal explicit-create
// and app-edit doors. Credentials come from OAuth and the production issuers;
// confirmations are never seeded and the install supplies the consumers.
func TestAccessConfirmationProfilesComposedInstallPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed install confirmation matrix requires PostgreSQL and native helpers")
	}
	t.Setenv("SMITHERS_ACCESS_CONFIRMATION_PROFILES", "1")
	r := newRehearsal(t, "SMITHERS_ACCESS_CONFIRMATION_PROFILES", "C-ACC-02", "confirmation-profiles-")
	require.True(t, r.install("Confirmation profiles"))
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
		workspace, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: repo.ID, UserID: person.member, Name: "confirmation-terminal-" + person.name, TargetBookmark: "main", Kind: "container", Status: "running"})
		require.NoError(t, err)
		session, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: workspace.ID, RepositoryID: repo.ID, UserID: person.member, Cols: 80, Rows: 24})
		require.NoError(t, err)
		token, err := issuer.MintForTerminal(ctx, person.member, repo.ID, workspace.ID, session.ID)
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/terminal_s1", token: token.Token, member: person.member, role: person.role, profile: "terminal_s1"})
		limited, err := issuer.CreateToken(ctx, person.member, services.CreateTokenRequest{Name: "confirmation-read-only", Via: "codex", Scopes: []string{"read:user", "read:repository"}})
		require.NoError(t, err)
		actors = append(actors, actor{name: person.name + "/read-only", token: limited.Token, member: person.member, role: person.role, profile: "read-only"})
	}

	var receipts []map[string]any
	call := func(t *testing.T, a actor, method, path, body, key, command string, status int, code string) *httptest.ResponseRecorder {
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
		if code != "" {
			var refusal struct{ Code, Class string }
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &refusal))
			require.Equal(t, code, refusal.Code)
			class := "permission"
			if code == "never" {
				class = "never"
			}
			if status == 409 {
				class = "conflict"
			}
			require.Equal(t, class, refusal.Class)
		}
		if status == 403 && (path == "/api/confirmations" && (a.token == "" || a.profile != "") || strings.HasSuffix(path, "/approve") || strings.HasSuffix(path, "/deny")) {
			require.Empty(t, decisions, "private ownership and person-session guards precede bound-action lookup")
		} else if status != 401 {
			require.Equal(t, []string{command}, decisions, "one bound action decision before effects or disclosure")
		} else {
			require.Empty(t, decisions)
		}
		receipts = append(receipts, map[string]any{"actor": a.name, "command": command, "method": method, "path": path, "status": out.Code, "decisions": decisions, "body": json.RawMessage(out.Body.Bytes())})
		return out
	}
	snapshot := func() string {
		var s string
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT jsonb_build_object('todos',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM mythical_items t),'members',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM collaborators t),'secrets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM repository_secrets t))::text`).Scan(&s))
		return s
	}
	count := func() int {
		var n int
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&n))
		return n
	}
	ids := map[string]bool{}
	for _, a := range actors {
		for _, target := range []struct {
			command, body string
			delegated     bool
			minRole       int
			never         bool
		}{
			{"todo.new", `{"command":"todo.new","subject":{"kind":"todo","ref":"new"},"payload":{"title":"Private append","prompt":"Private append","place":{"mode":"append"}}}`, true, 2, false},
			{"todo.steer", `{"command":"todo.steer","subject":{"kind":"todo","ref":"T1"},"payload":{"steer":"Do not execute"}}`, false, 2, false},
			{"secrets.set", `{"command":"secrets.set","payload":{"name":"FORBIDDEN","value":"never-disclose"}}`, false, 1, true},
		} {
			t.Run(a.name+"/"+target.command, func(t *testing.T) {
				before, n := snapshot(), count()
				status, code := 403, "permission"
				if a.token != "" && a.profile == "" && a.role <= target.minRole {
					if target.delegated {
						status, code = 202, ""
					} else if target.never {
						code = "never"
					}
				}
				key := "explicit-" + target.command
				out := call(t, a, "POST", "/api/confirmations", target.body, key, target.command, status, code)
				require.Equal(t, before, snapshot(), "requesting a card cannot execute the target")
				if status != 202 {
					require.Equal(t, n, count())
					return
				}
				var receipt map[string]string
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
				require.Len(t, receipt, 2)
				require.Equal(t, "pending", receipt["state"])
				id := receipt["confirmation"]
				require.NotEmpty(t, id)
				require.False(t, ids[id], "same key belongs to immutable credential identity")
				ids[id] = true
				require.Equal(t, n+1, count())
				replay := call(t, a, "POST", "/api/confirmations", target.body, key, target.command, 202, "")
				require.JSONEq(t, out.Body.String(), replay.Body.String())
				require.Equal(t, n+1, count())
				mismatch := strings.Replace(target.body, "Private append", "Changed private append", -1)
				call(t, a, "POST", "/api/confirmations", mismatch, key, target.command, 409, "idempotency_mismatch")
				require.Equal(t, n+1, count())
				// No delegated profile, including the requester, may approve or deny.
				for _, operation := range []string{"approve", "deny"} {
					for _, reader := range actors {
						if reader.token == "" && reader.member == a.member {
							continue
						}
						call(t, reader, "POST", "/api/confirmations/"+id+"/"+operation, `{}`, id+operation+reader.name, "todo.new", 403, "permission")
					}
				}
				own := people[a.member]
				denied := call(t, own, "POST", "/api/confirmations/"+id+"/deny", `{}`, "deny-"+id, "todo.new", 200, "")
				require.JSONEq(t, fmt.Sprintf(`{"id":%q,"state":"rejected"}`, id), denied.Body.String())
				again := call(t, own, "POST", "/api/confirmations/"+id+"/deny", `{}`, "deny-"+id, "todo.new", 200, "")
				require.JSONEq(t, denied.Body.String(), again.Body.String())
				call(t, own, "POST", "/api/confirmations/"+id+"/approve", `{}`, "deny-"+id, "todo.new", 409, "idempotency_mismatch")
				call(t, own, "POST", "/api/confirmations/"+id+"/approve", `{}`, "after-deny-"+id, "todo.new", 409, "confirmation_resolved")
				resolved := call(t, a, "POST", "/api/confirmations", target.body, key, target.command, 202, "")
				require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"rejected"}`, id), resolved.Body.String())
				require.Equal(t, before, snapshot())
				require.Equal(t, n+1, count())
			})
		}
	}
	require.Len(t, ids, 12)

	// Expired rows must replay their real state; expired credentials must never
	// disclose even that state. Use a fresh key and issuer identity per actor.
	for _, a := range actors {
		if a.token == "" || a.profile != "" {
			continue
		}
		t.Run("expiry/"+a.name, func(t *testing.T) {
			body := `{"command":"todo.new","payload":{"title":"Deadline","prompt":"Deadline"}}`
			before, n := snapshot(), count()
			out := call(t, a, "POST", "/api/confirmations", body, "expiry", "todo.new", 202, "")
			var card map[string]string
			require.NoError(t, json.Unmarshal(out.Body.Bytes(), &card))
			id := card["confirmation"]
			_, err := r.pool.Exec(ctx, `UPDATE approvals SET expires_at=now()-interval '1 second' WHERE id=$1`, id)
			require.NoError(t, err)
			replay := call(t, a, "POST", "/api/confirmations", body, "expiry", "todo.new", 202, "")
			require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"expired"}`, id), replay.Body.String())
			call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, "expired-press-"+id, "todo.new", 409, "confirmation_resolved")
			call(t, people[a.member], "POST", "/api/confirmations/"+id+"/deny", `{}`, "expired-deny-"+id, "todo.new", 409, "confirmation_resolved")
			require.Equal(t, before, snapshot())
			require.Equal(t, n+1, count())
		})
	}

	// Replacement credentials have a separate replay scope. Killing a credential
	// must refuse before disclosure of its previously persisted private result.
	for _, person := range []actor{actors[0], actors[5], actors[10]} {
		t.Run("credential-replay/"+person.name, func(t *testing.T) {
			body := `{"command":"todo.new","payload":{"prompt":"Credential-private replay"}}`
			first, err := issuer.CreateToken(ctx, person.member, services.CreateTokenRequest{Name: "original-confirmation", Via: "codex", Scopes: []string{"repo", "user"}})
			require.NoError(t, err)
			second, err := issuer.CreateToken(ctx, person.member, services.CreateTokenRequest{Name: "replacement-confirmation", Via: "codex", Scopes: []string{"repo", "user"}})
			require.NoError(t, err)
			a, b := person, person
			a.cookie = ""
			b.cookie = ""
			a.token = first.Token
			b.token = second.Token
			a.name += "/original"
			b.name += "/replacement"
			before, n := snapshot(), count()
			left := call(t, a, "POST", "/api/confirmations", body, "replacement-key", "todo.new", 202, "")
			right := call(t, b, "POST", "/api/confirmations", body, "replacement-key", "todo.new", 202, "")
			var l, rightCard map[string]string
			require.NoError(t, json.Unmarshal(left.Body.Bytes(), &l))
			require.NoError(t, json.Unmarshal(right.Body.Bytes(), &rightCard))
			require.NotEqual(t, l["confirmation"], rightCard["confirmation"])
			_, err = r.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1`, first.ID)
			require.NoError(t, err)
			dead := call(t, a, "POST", "/api/confirmations", body, "replacement-key", "todo.new", 401, "unauthenticated")
			require.NotContains(t, dead.Body.String(), l["confirmation"])
			replay := call(t, b, "POST", "/api/confirmations", body, "replacement-key", "todo.new", 202, "")
			require.JSONEq(t, right.Body.String(), replay.Body.String())
			require.NoError(t, issuer.DeleteToken(ctx, person.member, second.ID))
			dead = call(t, b, "POST", "/api/confirmations", body, "replacement-key", "todo.new", 401, "unauthenticated")
			require.NotContains(t, dead.Body.String(), rightCard["confirmation"])
			require.Equal(t, before, snapshot())
			require.Equal(t, n+2, count())
		})
	}

	// Flow and Agent card edits file repository TODOs through the same installed
	// consumer. They cannot apply instructions, mutate active versions or install
	// the proposed diff. Every role and trusted full profile uses the real door.
	editCells := 0
	for _, a := range actors {
		if a.profile != "" {
			continue
		}
		for _, door := range []struct{ command, name, path, title, prompt string }{
			{"flow.edit", "todo", "/api/flows/todo/edit", "Change the TODO flow: ", "Change flows/todo/flow.ts: "},
			{"agent.edit", "app", "/api/agents/app/edit", "Change the App agent: ", "Change instructions for the App agent in .smithers/instructions/app.md: "},
			{"agent.edit", "planner", "/api/agents/planner/edit", "Change the Planner agent: ", "Change instructions for the Planner agent in flows/todo/flow.ts: "},
			{"agent.edit", "implementer", "/api/agents/implementer/edit", "Change the Implementer agent: ", "Change instructions for the Implementer agent in flows/todo/flow.ts: "},
			{"agent.edit", "reviewer", "/api/agents/reviewer/edit", "Change the Reviewer agent: ", "Change instructions for the Reviewer agent in flows/todo/flow.ts: "},
		} {
			t.Run("app-edit/"+door.name+"/"+a.name, func(t *testing.T) {
				request := "[HOLD access-card-edits] " + a.name + " " + door.name
				bodyBytes, err := json.Marshal(map[string]string{"request": request})
				require.NoError(t, err)
				body, key := string(bodyBytes), "app-edit-"+door.name
				var todosBefore int
				require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&todosBefore))
				out := call(t, a, "POST", door.path, body, key, door.command, 202, "")
				var receipt map[string]any
				require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
				if a.token != "" {
					require.Len(t, receipt, 2)
					require.Equal(t, "pending", receipt["state"])
					var current int
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items`).Scan(&current))
					require.Equal(t, todosBefore, current)
					id := receipt["confirmation"].(string)
					call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, "app-edit-press-"+id, door.command, 200, "")
					call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, "app-edit-press-"+id, door.command, 200, "")
					replay := call(t, a, "POST", door.path, body, key, door.command, 202, "")
					require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, id), replay.Body.String())
				} else {
					require.Equal(t, "queued", receipt["state"])
					replay := call(t, a, "POST", door.path, body, key, door.command, 202, "")
					require.JSONEq(t, out.Body.String(), replay.Body.String())
				}
				var n, holder, createdBy int64
				var title, prompt string
				var matches int
				require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE title=$1`, door.title+request).Scan(&matches))
				require.Equal(t, 1, matches, "one edit files exactly one TODO")
				require.NoError(t, r.pool.QueryRow(ctx, `SELECT number,owner_id,created_by,title,revisions->0->>'text' FROM mythical_items WHERE title=$1`, door.title+request).Scan(&n, &holder, &createdBy, &title, &prompt))
				require.Equal(t, a.member, holder)
				require.Equal(t, a.member, createdBy)
				require.Equal(t, door.title+request, title)
				require.Contains(t, prompt, door.prompt+request)
				// Settle the newly filed work with the person door; no coding or merge
				// completion is counted by this control-plane matrix.
				call(t, people[a.member], "POST", fmt.Sprintf("/api/todos/%d", n), `{"op":"drop"}`, fmt.Sprintf("edit-drop-%d", n), "todo.drop", 202, "")
				editCells++
			})
		}
	}
	require.Equal(t, 75, editCells)
	require.Len(t, receipts, 1035)

	// Queued and retrying subjects have no guest destination yet. Their actual
	// stored revision/drop effects still cross the installed person dispatcher;
	// paused_at keeps the independent worker outside this observation interval.
	controlCells := 0
	for _, a := range actors {
		if a.profile != "" {
			continue
		}
		for _, state := range []string{"queued", "retrying"} {
			for _, ownership := range []string{"own", "other-member"} {
				for _, command := range []string{"todo.amend", "todo.drop"} {
					t.Run("control-effect/"+a.name+"/"+state+"/"+ownership+"/"+command, func(t *testing.T) {
						holder := a.member
						if ownership == "other-member" {
							holder = actors[0].member
							if holder == a.member {
								holder = actors[5].member
							}
						}
						var number int64
						require.NoError(t, r.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,issue_title,owner_id,created_by,revisions,checks,paused_at,attempt)
 VALUES($1,'todo',$2,'Control effect','Control effect',$3,$3,'[{"text":"Original prompt","acceptance":[]}]','{}',now(),1) RETURNING number`, repo.ID, state, holder).Scan(&number))
						path, method, payload := fmt.Sprintf("/api/todos/%d", number), "POST", `{"op":"drop"}`
						if command == "todo.amend" {
							method, payload = "PATCH", `{"prompt":"Confirmed amendment","acceptance":["Exactly one revision"]}`
						}
						key := fmt.Sprintf("control-%d", number)
						out := call(t, a, method, path, payload, key, command, 202, "")
						var receipt map[string]any
						require.NoError(t, json.Unmarshal(out.Body.Bytes(), &receipt))
						if a.token != "" {
							id := receipt["confirmation"].(string)
							require.Equal(t, "pending", receipt["state"])
							var priorState string
							var priorRevisions []byte
							require.NoError(t, r.pool.QueryRow(ctx, `SELECT state,revisions FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo.ID, number).Scan(&priorState, &priorRevisions))
							require.Equal(t, state, priorState)
							require.JSONEq(t, `[{"text":"Original prompt","acceptance":[]}]`, string(priorRevisions))
							call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, key+"-press", command, 200, "")
							call(t, people[a.member], "POST", "/api/confirmations/"+id+"/approve", `{}`, key+"-press", command, 200, "")
							replay := call(t, a, method, path, payload, key, command, 202, "")
							require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, id), replay.Body.String())
						} else {
							require.Equal(t, "accepted", receipt["state"])
							replay := call(t, a, method, path, payload, key, command, 202, "")
							require.JSONEq(t, out.Body.String(), replay.Body.String())
						}
						var actualState string
						var actualOwner int64
						var raw []byte
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT state,owner_id,revisions FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo.ID, number).Scan(&actualState, &actualOwner, &raw))
						require.Equal(t, holder, actualOwner)
						var revisions []struct {
							Text       string
							Acceptance []string
						}
						require.NoError(t, json.Unmarshal(raw, &revisions))
						if command == "todo.amend" {
							require.Len(t, revisions, 2)
							require.Equal(t, "Original prompt", revisions[0].Text)
							require.Equal(t, "Confirmed amendment", revisions[1].Text)
							require.Equal(t, []string{"Exactly one revision"}, revisions[1].Acceptance)
							call(t, people[a.member], "POST", path, `{"op":"drop"}`, key+"-cleanup", "todo.drop", 202, "")
						} else {
							require.Equal(t, "cancelled", actualState)
							require.Len(t, revisions, 1)
						}
						controlCells++
					})
				}
			}
		}
	}
	require.Equal(t, 120, controlCells)

	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "isolated-confirmation-profiles.json"), accessProfilesJSON(t, map[string]any{"boundary": "composed install OAuth and production confirmation dispatcher", "explicit_cards": len(ids), "app_edit_effect_cells": editCells, "queued_retrying_control_effect_cells": controlCells, "cells": receipts, "test_passed": !t.Failed(), "full_C_ACC_02_complete": false}), 0600))
	t.Logf("confirmation profiles: %d HTTP cells, %d isolated private cards", len(receipts), len(ids))
}

func accessProfilesJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	require.NoError(t, err)
	return data
}
