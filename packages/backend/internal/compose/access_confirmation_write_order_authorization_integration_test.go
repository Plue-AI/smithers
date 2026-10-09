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
	testAccessConfirmationWriteOrder(t, "todo.new", false)
}

func TestAccessConfirmationConsumerWriteOrderComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed confirmation write-order matrix requires PostgreSQL")
	}
	for _, command := range []string{"issue.new", "wiki.create", "flow.edit", "agent.edit"} {
		t.Run(command, func(t *testing.T) { testAccessConfirmationWriteOrder(t, command, false) })
	}
}

func TestAccessConfirmationConsumerIdentityComposedPostgres(t *testing.T) {
	if testing.Short() {
		t.Skip("composed confirmation identity matrix requires PostgreSQL")
	}
	for _, command := range []string{"todo.new", "issue.new", "wiki.create", "flow.edit", "agent.edit"} {
		t.Run(command, func(t *testing.T) { testAccessConfirmationWriteOrder(t, command, true) })
	}
}

func testAccessConfirmationWriteOrder(t *testing.T, command string, identityOnly bool) {
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
		req.Header.Set("Smithers-Actor", "person")
		req.Header.Set("Smithers-Via", "terminal")
		req.Header.Set("Smithers-Profile", "full")
		// A live requester cookie cannot promote or rescue a delegated bearer.
		// Expiry cells leave this cookie live while the selected token dies.
		req.AddCookie(&http.Cookie{Name: a.cookieName, Value: a.cookie})
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "order"})
		req.Header.Set("X-CSRF-Token", "order")
		if delegated {
			req.Header.Set("Authorization", "Bearer "+a.token)
		}
		var decisions []string
		req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { decisions = append(decisions, command) }))
		out := httptest.NewRecorder()
		r.server.Config.Handler.ServeHTTP(out, req)
		return response{out.Code, out.Body.String(), decisions}
	}
	bodyFor := func(a identity) string {
		switch command {
		case "issue.new":
			return `{"command":"issue.new","subject":{"kind":"issue","ref":"new"},"payload":{"title":"Private ordered issue","body":"Exact private issue bytes"}}`
		case "wiki.create":
			return fmt.Sprintf(`{"command":"wiki.create","subject":{"kind":"wiki","ref":"order-%d"},"payload":{"owner":"rehearsal-owner","repo":"app","page":{"slug":"order-%d","title":"Ordered page","body":"Exact private page bytes"}}}`, a.user, a.user)
		case "flow.edit":
			return `{"command":"flow.edit","subject":{"kind":"flow","ref":"todo"},"payload":{"request":"[HOLD access-order] Change the TODO flow"}}`
		case "agent.edit":
			return `{"command":"agent.edit","subject":{"kind":"agent","ref":"app"},"payload":{"request":"[HOLD access-order] Change App instructions"}}`
		default:
			return `{"command":"todo.new","payload":{"title":"[HOLD access-order] Private","prompt":"[HOLD access-order] Private"}}`
		}
	}
	create := func(t *testing.T, a identity, key string) string {
		t.Helper()
		out := call(ctx, a, true, "/api/confirmations", bodyFor(a), key)
		require.Equal(t, 202, out.status, out.body)
		require.Equal(t, []string{command}, out.decisions)
		var row map[string]string
		require.NoError(t, json.Unmarshal([]byte(out.body), &row))
		require.Equal(t, "pending", row["state"])
		require.NotEmpty(t, row["confirmation"])
		return row["confirmation"]
	}
	snapshot := func(t *testing.T) string {
		t.Helper()
		var s string
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT jsonb_build_object('cards',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM approvals a),'todos',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') FROM mythical_items i),'wiki',(SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]') FROM wiki_pages w))::text`).Scan(&s))
		return s
	}
	effects := func(t *testing.T) int {
		t.Helper()
		var n int
		require.NoError(t, r.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM mythical_items)+(SELECT count(*) FROM wiki_pages)+(SELECT count(*) FROM product_job_requests WHERE operation='install.issue.create')`).Scan(&n))
		return n
	}
	vias := []string{"cli", "codex", "claude-code", "smithers"}
	if command == "wiki.create" || command == "flow.edit" || command == "agent.edit" {
		vias = []string{"smithers"}
	}
	if identityOnly {
		var identities []map[string]any
		for _, via := range vias {
			for _, role := range []string{"admin", "write"} {
				t.Run(via+"/"+role+"/immutable-credential", func(t *testing.T) {
					a := actor(t, role, via)
					beforeEffects := effects(t)
					issuer := services.NewAuthService(q, config.AuthConfig{Mode: "selfhost"}, nil, nil)
					issuer.Members = &services.Members{Pool: r.pool}
					b := a
					if via == "smithers" {
						token, err := issuer.MintForTurn(ctx, a.user, liveAppTurnCredentialFixture(t, r.pool, a.user), 1)
						require.NoError(t, err)
						b.token = token.Token
					} else {
						token, err := issuer.CreateToken(ctx, a.user, services.CreateTokenRequest{Name: "identity-replacement", Via: via, Scopes: []string{"repo", "user"}})
						require.NoError(t, err)
						b.token = token.Token
					}
					require.NotEqual(t, a.token, b.token)
					var beforeCards, afterCards int
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&beforeCards))
					left, right := create(t, a, "identity-key"), create(t, b, "identity-key")
					require.NotEqual(t, left, right, "same member and key still belong to immutable credential identities")
					replay := call(ctx, a, true, "/api/confirmations", bodyFor(a), "identity-key")
					require.Equal(t, 202, replay.status, replay.body)
					require.Equal(t, []string{command}, replay.decisions)
					require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"pending"}`, left), replay.body)
					// Object order and whitespace do not change the canonical request.
					var canonical map[string]any
					require.NoError(t, json.Unmarshal([]byte(bodyFor(a)), &canonical))
					reordered, err := json.MarshalIndent(canonical, "", "  ")
					require.NoError(t, err)
					equivalent := call(ctx, a, true, "/api/confirmations", string(reordered), "identity-key")
					require.Equal(t, 202, equivalent.status, equivalent.body)
					require.Equal(t, []string{command}, equivalent.decisions)
					require.JSONEq(t, replay.body, equivalent.body)
					// Explicit defaults and inferred subject/name fields canonicalize to
					// the same action, rather than becoming an idempotency conflict.
					switch command {
					case "todo.new":
						canonical["subject"] = map[string]string{"kind": "todo", "ref": "new"}
						canonical["payload"].(map[string]any)["place"] = map[string]string{"mode": "append"}
					case "wiki.create":
						canonical["payload"].(map[string]any)["visibility"] = "public"
					case "flow.edit", "agent.edit":
						canonical["payload"].(map[string]any)["name"] = canonical["subject"].(map[string]any)["ref"]
					}
					normalized, err := json.Marshal(canonical)
					require.NoError(t, err)
					equivalent = call(ctx, a, true, "/api/confirmations", string(normalized), "identity-key")
					require.Equal(t, 202, equivalent.status, equivalent.body)
					require.Equal(t, []string{command}, equivalent.decisions)
					require.JSONEq(t, replay.body, equivalent.body)
					if command == "wiki.create" || command == "flow.edit" || command == "agent.edit" {
						var changedSubject map[string]any
						require.NoError(t, json.Unmarshal([]byte(bodyFor(a)), &changedSubject))
						ref := map[string]string{"wiki.create": fmt.Sprintf("another-%d", a.user), "flow.edit": "review", "agent.edit": "planner"}[command]
						changedSubject["subject"].(map[string]any)["ref"] = ref
						if command == "wiki.create" {
							changedSubject["payload"].(map[string]any)["page"].(map[string]any)["slug"] = ref
						}
						raw, err := json.Marshal(changedSubject)
						require.NoError(t, err)
						mismatch := call(ctx, a, true, "/api/confirmations", string(raw), "identity-key")
						require.Equal(t, 409, mismatch.status, mismatch.body)
						require.Contains(t, mismatch.body, `"code":"idempotency_mismatch"`)
						require.Equal(t, []string{command}, mismatch.decisions)
					}
					var payload map[string]any
					require.NoError(t, json.Unmarshal([]byte(bodyFor(a)), &payload))
					input := payload["payload"].(map[string]any)
					switch command {
					case "wiki.create":
						input["page"].(map[string]any)["body"] = "Changed private bytes"
					case "issue.new":
						input["body"] = "Changed private bytes"
					case "flow.edit", "agent.edit":
						input["request"] = "[HOLD access-order] Changed request"
					default:
						input["prompt"] = "[HOLD access-order] Changed prompt"
					}
					mismatchBody, err := json.Marshal(payload)
					require.NoError(t, err)
					mismatch := call(ctx, a, true, "/api/confirmations", string(mismatchBody), "identity-key")
					require.Equal(t, 409, mismatch.status, mismatch.body)
					require.Contains(t, mismatch.body, `"code":"idempotency_mismatch"`)
					require.Equal(t, []string{command}, mismatch.decisions)
					otherCommand := "todo.new"
					otherBody := `{"command":"todo.new","payload":{"prompt":"[HOLD access-order] Different command"}}`
					if command == "todo.new" {
						otherCommand = "issue.new"
						otherBody = `{"command":"issue.new","subject":{"kind":"issue","ref":"new"},"payload":{"title":"Different command","body":"Private bytes"}}`
					}
					mismatch = call(ctx, a, true, "/api/confirmations", otherBody, "identity-key")
					require.Equal(t, 409, mismatch.status, mismatch.body)
					require.Contains(t, mismatch.body, `"code":"idempotency_mismatch"`)
					require.Equal(t, []string{otherCommand}, mismatch.decisions)
					// A denial settles only this credential's card. Reusing its create
					// key must report rejected, without leaking or settling the other card.
					denied := call(ctx, a, false, "/api/confirmations/"+left+"/deny", `{}`, "identity-deny")
					require.Equal(t, 200, denied.status, denied.body)
					require.Equal(t, []string{command}, denied.decisions)
					replay = call(ctx, a, true, "/api/confirmations", bodyFor(a), "identity-key")
					require.Equal(t, 202, replay.status, replay.body)
					require.Equal(t, []string{command}, replay.decisions)
					require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"rejected"}`, left), replay.body)
					for _, press := range []struct {
						verb, key string
						status    int
					}{
						{"deny", "identity-deny", 200},
						{"deny", "another-deny", 409},
						{"approve", "identity-deny", 409},
						{"approve", "another-approve", 409},
					} {
						out := call(ctx, a, false, "/api/confirmations/"+left+"/"+press.verb, `{}`, press.key)
						require.Equal(t, press.status, out.status, out.body)
						require.Equal(t, []string{command}, out.decisions)
						if press.status == 200 {
							require.JSONEq(t, denied.body, out.body)
						}
					}
					digest := sha256.Sum256([]byte(a.token))
					changed, err := r.pool.Exec(ctx, `UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, hex.EncodeToString(digest[:]))
					require.NoError(t, err)
					require.EqualValues(t, 1, changed.RowsAffected())
					dead := call(ctx, a, true, "/api/confirmations", bodyFor(a), "identity-key")
					require.Equal(t, 401, dead.status, dead.body)
					require.Contains(t, dead.body, `"code":"unauthenticated"`)
					require.Empty(t, dead.decisions)
					require.NotContains(t, dead.body, left)
					replay = call(ctx, b, true, "/api/confirmations", bodyFor(b), "identity-key")
					require.Equal(t, 202, replay.status, replay.body)
					require.Equal(t, []string{command}, replay.decisions)
					require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"pending"}`, right), replay.body)
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&afterCards))
					require.Equal(t, beforeCards+2, afterCards)
					require.Equal(t, beforeEffects, effects(t), "identity isolation, mismatches and denial cannot execute any target")
					approved := call(ctx, b, false, "/api/confirmations/"+right+"/approve", `{}`, "identity-approve")
					require.Equal(t, 200, approved.status, approved.body)
					require.Equal(t, []string{command}, approved.decisions)
					for range 2 {
						replay = call(ctx, b, true, "/api/confirmations", bodyFor(b), "identity-key")
						require.Equal(t, 202, replay.status, replay.body)
						require.Equal(t, []string{command}, replay.decisions)
						require.JSONEq(t, fmt.Sprintf(`{"confirmation":%q,"state":"approved"}`, right), replay.body)
						duplicate := call(ctx, b, false, "/api/confirmations/"+right+"/approve", `{}`, "identity-approve")
						require.Equal(t, 200, duplicate.status, duplicate.body)
						require.Equal(t, []string{command}, duplicate.decisions)
						require.JSONEq(t, approved.body, duplicate.body)
					}
					require.Equal(t, beforeEffects+1, effects(t), "resolved replay creates exactly one durable target effect")
					require.NoError(t, r.pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&afterCards))
					require.Equal(t, beforeCards+2, afterCards, "resolved create replay must not create a new card")
					if command != "wiki.create" && command != "issue.new" {
						var number int64
						require.NoError(t, r.pool.QueryRow(ctx, `SELECT number FROM mythical_items WHERE created_by=$1`, b.user).Scan(&number))
						_, err := r.expect("POST", fmt.Sprintf("/api/todos/%d", number), `{"op":"drop"}`, 202)
						require.NoError(t, err)
					}
					// Even a saved approved result remains behind current membership.
					_, err = r.pool.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE repository_id=$1 AND user_id=$2`, repo.ID, b.user)
					require.NoError(t, err)
					before := snapshot(t)
					for _, delegated := range []bool{true, false} {
						path, body, key := "/api/confirmations", bodyFor(b), "identity-key"
						if !delegated {
							path, body, key = "/api/confirmations/"+right+"/approve", `{}`, "identity-approve"
						}
						dead := call(ctx, b, delegated, path, body, key)
						require.Equal(t, 401, dead.status, dead.body)
						require.Contains(t, dead.body, `"code":"unauthenticated"`)
						require.Empty(t, dead.decisions)
						require.NotContains(t, dead.body, right)
					}
					require.Equal(t, before, snapshot(t))
					identities = append(identities, map[string]any{"profile": via, "role": role, "command": command, "distinct_cards": 2, "payload_mismatch": 409, "command_mismatch": 409, "dead_bearer_live_cookie_replay": 401, "replacement_replay": 202, "canonical_equivalent_replay": 202, "normalized_default_replay": 202, "subject_mismatch_qualified": command == "wiki.create" || command == "flow.edit" || command == "agent.edit", "rejected_replay": 202, "approved_replay": 202, "suspended_resolved_replay": 401, "durable_effects": 1})
				})
			}
		}
		require.Len(t, identities, 2*len(vias))
		require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "confirmation-consumer-identity.json"), accessProfilesJSON(t, map[string]any{"boundary": "composed HTTP and production credential issuers", "cells": identities, "full_C_ACC_02_complete": false}), 0600))
		return
	}
	var receipts []map[string]any
	for _, via := range vias {
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
						requestBody := bodyFor(a)
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
							require.Equal(t, []string{command}, out.decisions)
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
						require.Zero(t, effects(t), "refused or expired commands create no page, TODO or outbound intent")
						receipts = append(receipts, map[string]any{"profile": via, "role": role, "operation": operation, "transition": change, "order": "transition-before-write", "status": out.status, "decisions": out.decisions, "todo_effects": 0})
					})
				}
			}
		}
	}
	require.Len(t, receipts, 38*len(vias))
	// The opposite order permits the committed action. A later member removal
	// cannot erase it, and replay must authenticate before disclosing its result.
	for _, via := range vias {
		for _, role := range []string{"admin", "write"} {
			for _, operation := range []string{"approve", "deny"} {
				t.Run(via+"/"+role+"/"+operation+"/write-before-remove", func(t *testing.T) {
					a := actor(t, role, via)
					id := create(t, a, "write-first")
					path := "/api/confirmations/" + id + "/" + operation
					beforeEffects := effects(t)
					// Concurrent duplicate presses take the same production lock and
					// durable operation key, so only one underlying action commits.
					pressed := make(chan response, 2)
					for range 2 {
						go func() { pressed <- call(ctx, a, false, path, `{}`, "write-first-press") }()
					}
					out := <-pressed
					duplicate := <-pressed
					require.Equal(t, 200, duplicate.status, duplicate.body)
					require.Equal(t, []string{command}, duplicate.decisions)
					require.JSONEq(t, out.body, duplicate.body)
					require.Equal(t, 200, out.status, out.body)
					require.Equal(t, []string{command}, out.decisions)
					state := "rejected"
					if operation == "approve" {
						state = "approved"
					}
					require.JSONEq(t, fmt.Sprintf(`{"id":%q,"state":%q}`, id, state), out.body)
					again := call(ctx, a, false, path, `{}`, "write-first-press")
					require.Equal(t, 200, again.status, again.body)
					require.Equal(t, []string{command}, again.decisions)
					require.JSONEq(t, out.body, again.body)
					wantEffects := beforeEffects
					if operation == "approve" {
						wantEffects++
					}
					require.Equal(t, wantEffects, effects(t), "duplicate approval has exactly one durable effect; denial has none")
					if operation == "approve" && command != "wiki.create" && command != "issue.new" {
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
					require.Equal(t, []string{command}, otherSession.decisions)
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
					receipts = append(receipts, map[string]any{"profile": via, "role": role, "operation": operation, "transition": "remove", "order": "write-before-transition", "status": out.status, "replay_after_removal": dead.status, "durable_effects": map[bool]int{true: 1, false: 0}[operation == "approve"]})
				})
			}
		}
	}
	require.Len(t, receipts, 42*len(vias))
	require.NoError(t, os.WriteFile(filepath.Join(r.evidence, "confirmation-write-order.json"), accessProfilesJSON(t, map[string]any{"boundary": "composed install HTTP and production write lock", "command": command, "cells": receipts, "full_C_ACC_02_complete": false}), 0600))
}
