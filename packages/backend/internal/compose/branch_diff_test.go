package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTODOBranchDiffInstallComposition(t *testing.T) {
	for _, mode := range []string{config.AuthModeSelfHosted, config.AuthModeMultitenant} {
		t.Run(mode, func(t *testing.T) {
			cfg := testConfigAllFlagsOn()
			cfg.Auth.Mode = mode
			served := map[string]servedRoute{}
			walkServedRoutes(t, openAPIConformanceRouter(cfg), served)
			for _, route := range []string{"get /api/branches/{b}/diff", "post /api/branches/{b}"} {
				_, mounted := served[route]
				require.Equal(t, mode == config.AuthModeSelfHosted, mounted, route)
			}
		})
	}
}

// Person-facing install router, live cookie authorization and real PostgreSQL.
// The persisted observation is seeded; native retention and GitHub transport
// are covered separately by the fetched consumer tests.
func TestForeignPushAnswersComposedInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "pushowner", LowerUsername: "pushowner"})
	require.NoError(t, err)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"pushowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo.ID, member.ID)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	session := func(u db.User) string {
		cookie := u.Username + "-cookie"
		digest := sha256.Sum256([]byte(cookie))
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: u.ID, Username: u.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return cookie
	}
	ownerCookie, memberCookie := session(owner), session(member)
	head := strings.Repeat("a", 40)
	checks := fmt.Sprintf(`{"todo":true,"branch":"smithers/retry","foreignHead":"%s","fault":{"kind":"fixture"},"waits":[{"id":"question","kind":"question","prompt":"Keep?","since":"2026-10-05T08:00:00Z"},{"id":"foreign","kind":"foreign_push","sha":"%s","by":{"kind":"github","login":"Alice","color_index":7},"prompt":"Alice pushed","since":"2026-10-05T08:01:00Z"}]}`, head, head)
	item, _, err := q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: repo.ID, State: "blocked", Checks: []byte(checks)})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=4,owner_id=$2,pr_number=4,pr_state='open',pr_head=$3,candidate_head=$4,candidate_verified=true,paused_at=now(),reason='retain failure' WHERE id=$1`, item.ID, owner.ID, strings.Repeat("b", 40), strings.Repeat("c", 40))
	require.NoError(t, err)
	before, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: unusedChatHost{}}))
	defer server.Close()
	call := func(cookie, body, key string, status int) string {
		req, err := http.NewRequest("POST", server.URL+"/api/branches/smithers%2Fretry", strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", "csrf-fixture")
		req.Header.Set("Idempotency-Key", key)
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, status, res.StatusCode, string(raw))
		return string(raw)
	}
	// Agent requests cross the same installed authorization/confirmation doors.
	// Requests persist one private confirmation without consuming the foreign wait.
	tokenFor := func(user db.User, digit string) string {
		token := "smithers_" + strings.Repeat(digit, 40)
		digest := sha256.Sum256([]byte(token))
		hash := hex.EncodeToString(digest[:])
		_, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: user.ID, Name: "foreign-answer", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository,via:smithers,terminal-session:" + liveAppTurnCredentialFixture(t, pool, user.ID) + "/1", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, err)
		return token
	}
	ownerToken, memberToken := tokenFor(owner, "e"), tokenFor(member, "f")
	confirmationCall := func(path, token, cookie, body, key string, status int, code string) string {
		callBefore, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		req, err := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.Header.Set("Origin", "http://127.0.0.1:4000")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", key)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
			req.Header.Set("X-CSRF-Token", "csrf-fixture")
		}
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.Equal(t, status, res.StatusCode, string(raw))
		if code != "" {
			require.Contains(t, string(raw), `"code":"`+code+`"`)
		}
		unchanged, err := q.GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		if status != 200 || !strings.HasSuffix(path, "/approve") {
			require.Equal(t, callBefore, unchanged)
		}
		return string(raw)
	}
	confirmationIDs := map[string]string{}
	for _, test := range []struct {
		name, command, token, code string
		status                     int
	}{
		{"member-discard", "branch.discard-foreign", memberToken, "permission", 403},
		{"member-bring", "branch.bring-in", memberToken, "", 202},
		{"owner-discard", "branch.discard-foreign", ownerToken, "", 202},
		{"owner-bring", "branch.bring-in", ownerToken, "", 202},
	} {
		t.Run(test.name, func(t *testing.T) {
			payload := fmt.Sprintf(`{"command":%q,"subject":{"kind":"branch","ref":"smithers/retry"},"payload":{"id":"foreign","revision":%q}}`, test.command, head)
			raw := confirmationCall("/api/confirmations", test.token, "", payload, test.name, test.status, test.code)
			if test.status == 202 {
				var receipt map[string]string
				require.NoError(t, json.Unmarshal([]byte(raw), &receipt))
				confirmationIDs[test.name] = receipt["confirmation"]
				require.NotEmpty(t, receipt["confirmation"])
				confirmationCall("/api/confirmations", test.token, "", payload, test.name, 202, "")
			}
		})
	}
	confirmationCall("/api/confirmations/"+confirmationIDs["member-bring"]+"/approve", "", ownerCookie, `{}`, "other-person", 403, "permission")
	confirmationCall("/api/confirmations", ownerToken, "", fmt.Sprintf(`{"command":"branch.discard-foreign","subject":{"kind":"branch","ref":"smithers/retry"},"payload":{"id":"foreign","revision":%q}}`, strings.Repeat("d", 40)), "agent-stale", 409, "conflict")
	// A downgraded/read-only delegation cannot acquire confirmation authority.
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes=replace(scopes,'write:repository,','') WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	for _, command := range []string{"branch.bring-in", "branch.discard-foreign"} {
		confirmationCall("/api/confirmations", ownerToken, "", fmt.Sprintf(`{"command":%q}`, command), "read-only-"+command, 403, "permission")
	}
	_, err = pool.Exec(ctx, `UPDATE access_tokens SET scopes='write:repository,' || scopes WHERE user_id=$1`, owner.ID)
	require.NoError(t, err)
	for _, answer := range []string{"bring-in", "discard-foreign"} {
		raw := confirmationCall("/api/branches/smithers%2Fretry", ownerToken, "", fmt.Sprintf(`{"op":%q,"id":"foreign","revision":%q}`, answer, head), "direct-"+answer, 202, "")
		var receipt map[string]string
		require.NoError(t, json.Unmarshal([]byte(raw), &receipt))
		confirmationCall("/api/confirmations/"+receipt["confirmation"]+"/deny", "", ownerCookie, `{}`, "cancel-direct-"+answer, 200, "")
	}
	var confirmations int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM approvals`).Scan(&confirmations))
	require.Equal(t, 5, confirmations)
	confirmationCall("/api/confirmations/"+confirmationIDs["owner-bring"]+"/approve", "", ownerCookie, `{}`, "bring-press", 503, "checkpoint_rebase_unavailable")
	for _, command := range []string{"branch.bring-in", "branch.discard-foreign"} {
		id := uuid.NewString()
		_, err := pool.Exec(ctx, `INSERT INTO approvals(id,repository_id,state,kind,title,member_id,credential_id,command,subject,revision,payload,expires_at) VALUES($1,$2,'pending','one_click','Outside push',$3,'requesting-agent',$4,'{"kind":"branch","ref":"smithers/retry"}',$5,'{"id":"foreign"}',now()+interval '1 hour')`, id, repo.ID, owner.ID, command, head)
		require.NoError(t, err)
		confirmationCall("/api/confirmations/"+id+"/approve", "", ownerCookie, `{}`, "press-"+command, 503, "confirmation_unavailable")
		var state string
		var decisionKey *string
		require.NoError(t, pool.QueryRow(ctx, `SELECT state,decision_key FROM approvals WHERE id=$1`, id).Scan(&state, &decisionKey))
		require.Equal(t, "pending", state)
		require.Nil(t, decisionKey)
	}
	body := fmt.Sprintf(`{"op":"discard-foreign","id":"foreign","revision":"%s"}`, head)
	require.Contains(t, call(memberCookie, body, "member", 403), `"class":"permission"`)
	require.Contains(t, call(ownerCookie, strings.Replace(body, head, strings.Repeat("d", 40), 1), "stale", 409), `"class":"conflict"`)
	call(ownerCookie, strings.Replace(body, `"foreign"`, `"question"`, 1), "wrong-wait", 409)
	call(ownerCookie, strings.Replace(body, "discard-foreign", "bring-in", 1), "bring", 503)
	call(ownerCookie, body, "", 400)
	untouched, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, before, untouched)
	// The agent's request has no effect until this person presses it.
	confirmationRequest, err := http.NewRequest("POST", server.URL+"/api/confirmations/"+confirmationIDs["owner-discard"]+"/approve", strings.NewReader(`{}`))
	require.NoError(t, err)
	confirmationRequest.Host = "127.0.0.1:4000"
	confirmationRequest.Header.Set("Origin", "http://127.0.0.1:4000")
	confirmationRequest.Header.Set("Content-Type", "application/json")
	confirmationRequest.Header.Set("X-CSRF-Token", "csrf-fixture")
	confirmationRequest.Header.Set("Idempotency-Key", "discard-press")
	confirmationRequest.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
	confirmationRequest.AddCookie(&http.Cookie{Name: "smithers_session", Value: ownerCookie})
	response, err := server.Client().Do(confirmationRequest)
	require.NoError(t, err)
	responseBody, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	response.Body.Close()
	require.Equal(t, 200, response.StatusCode, string(responseBody))
	var confirmationState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, confirmationIDs["owner-discard"]).Scan(&confirmationState))
	require.Equal(t, "approved", confirmationState)
	after, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, head, after.PRHead)
	require.Equal(t, before.CandidateHead, after.CandidateHead)
	require.Equal(t, before.CandidateVerified, after.CandidateVerified)
	require.Equal(t, before.PausedAt, after.PausedAt)
	require.Equal(t, before.State, after.State)
	require.Equal(t, before.Reason, after.Reason)
	var stored struct {
		ForeignHead string
		Waits       []map[string]any
		Fault       map[string]any
	}
	require.NoError(t, json.Unmarshal(after.Checks, &stored))
	require.Empty(t, stored.ForeignHead)
	require.Len(t, stored.Waits, 2)
	require.Nil(t, stored.Waits[0]["settled_at"])
	require.Equal(t, "Alice", stored.Waits[1]["by"].(map[string]any)["login"])
	require.Equal(t, "pushowner", stored.Waits[1]["answered_by"])
	require.NotNil(t, stored.Fault)
	call(ownerCookie, body, "confirmation:"+confirmationIDs["owner-discard"], 202)
	call(ownerCookie, body, "another-answer", 409)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
	require.Equal(t, 1, count)
	call(ownerCookie, strings.Replace(body, `"id":"foreign"`, `"id":"changed"`, 1), "confirmation:"+confirmationIDs["owner-discard"], 409)
	// A later outside push is independent of the earlier decision receipt.
	// Replaying the first press must not settle or lease against the new head.
	newHead := strings.Repeat("e", 40)
	var newer map[string]any
	require.NoError(t, json.Unmarshal(after.Checks, &newer))
	newer["foreignHead"] = newHead
	newer["waits"] = append(newer["waits"].([]any), map[string]any{
		"id": "foreign-new", "kind": "foreign_push", "sha": newHead,
		"by":     map[string]any{"kind": "github", "login": "Alice", "color_index": 7},
		"prompt": "Alice pushed again", "since": "2026-10-05T10:00:00Z",
	})
	newChecks, err := json.Marshal(newer)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, newChecks)
	require.NoError(t, err)
	observed, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	confirmationCall("/api/confirmations/"+confirmationIDs["owner-bring"]+"/approve", "", ownerCookie, `{}`, "bring-after-new-push", 409, "confirmation_resolved")
	var expiredState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, confirmationIDs["owner-bring"]).Scan(&expiredState))
	require.Equal(t, "expired", expiredState)
	call(ownerCookie, body, "confirmation:"+confirmationIDs["owner-discard"], 202)
	call(ownerCookie, body, "old-answer-after-new-push", 409)
	staleNew := strings.Replace(body, `"id":"foreign"`, `"id":"foreign-new"`, 1)
	call(ownerCookie, staleNew, "new-wait-old-head", 409)
	unchanged, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, observed, unchanged)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
	require.Equal(t, 1, count)
	current := strings.Replace(staleNew, head, newHead, 1)
	call(ownerCookie, current, "new-discard", 202)
	newDecision, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, newHead, newDecision.PRHead)
	require.Equal(t, observed.CandidateHead, newDecision.CandidateHead)
	require.Equal(t, observed.PausedAt, newDecision.PausedAt)
	var decided struct {
		ForeignHead string
		Waits       []map[string]any
	}
	require.NoError(t, json.Unmarshal(newDecision.Checks, &decided))
	require.Empty(t, decided.ForeignHead)
	require.Len(t, decided.Waits, 3)
	require.Nil(t, decided.Waits[0]["settled_at"])
	require.NotNil(t, decided.Waits[1]["settled_at"])
	require.NotNil(t, decided.Waits[2]["settled_at"])
	require.Equal(t, "discard-foreign", decided.Waits[2]["answer"])
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
	require.Equal(t, 2, count)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	call(ownerCookie, body, "confirmation:"+confirmationIDs["owner-discard"], 202)
	call(ownerCookie, body, "after-merge", 409)
	// Literal C-STK-08 precedence cases through the install's served doors.
	// Only the foreign wait settles; the phase, pause and question survive.
	readCard := func() map[string]any {
		req, err := http.NewRequest("GET", server.URL+"/api/todos/4", nil)
		require.NoError(t, err)
		req.Host = "127.0.0.1:4000"
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: ownerCookie})
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		defer res.Body.Close()
		var card map[string]any
		require.NoError(t, json.NewDecoder(res.Body).Decode(&card))
		require.Equal(t, 200, res.StatusCode, card)
		return card
	}
	cases := []struct {
		name, engine, after string
		paused, question    bool
	}{
		{"working", "running", "working", false, false},
		{"paused", "running", "paused", true, false},
		{"failed", "blocked", "failed", false, false},
		{"question", "running", "needs_you", false, true},
		{"paused-question", "running", "needs_you", true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var fixture map[string]any
			require.NoError(t, json.Unmarshal([]byte(checks), &fixture))
			fixture["run_launched"], fixture["run_attached"] = true, true
			if !c.question {
				fixture["waits"].([]any)[0].(map[string]any)["settled_at"] = "2026-10-05T09:00:00Z"
			}
			raw, err := json.Marshal(fixture)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `UPDATE mythical_items SET state=$2,checks=$3,attempt=1,request_run_id='retained-run',
			 paused_at=CASE WHEN $4 THEN NOW() ELSE NULL END,pending_op=NULL,pr_state='open' WHERE id=$1`, item.ID, c.engine, raw, c.paused)
			require.NoError(t, err)
			before, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, "needs_you", readCard()["state"])
			var prior int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&prior))
			call(ownerCookie, body, "discard-"+c.name, 202)
			require.Equal(t, c.after, readCard()["state"])
			after, err := q.GetMythicalItem(ctx, item.ID)
			require.NoError(t, err)
			require.Equal(t, before.State, after.State)
			require.Equal(t, before.PausedAt, after.PausedAt)
			require.Equal(t, before.RequestRunID, after.RequestRunID)
			require.Equal(t, before.CandidateHead, after.CandidateHead)
			var waits struct {
				Waits []struct {
					SettledAt *string `json:"settled_at"`
				} `json:"waits"`
			}
			require.NoError(t, json.Unmarshal(after.Checks, &waits))
			require.Len(t, waits.Waits, 2)
			require.NotNil(t, waits.Waits[1].SettledAt)
			require.Equal(t, !c.question, waits.Waits[0].SettledAt != nil)
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='todo.foreign_discard-foreign'`).Scan(&count))
			require.Equal(t, prior+1, count)
			if c.name == "failed" {
				req, err := http.NewRequest("POST", server.URL+"/api/todos/4", strings.NewReader(`{"op":"retry"}`))
				require.NoError(t, err)
				req.Host = "127.0.0.1:4000"
				req.Header.Set("Origin", "http://127.0.0.1:4000")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-CSRF-Token", "csrf-fixture")
				req.Header.Set("Idempotency-Key", "retry-after-discard")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf-fixture"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: ownerCookie})
				res, err := server.Client().Do(req)
				require.NoError(t, err)
				defer res.Body.Close()
				var receipt map[string]any
				require.NoError(t, json.NewDecoder(res.Body).Decode(&receipt))
				require.Equal(t, 202, res.StatusCode, receipt)
				require.EqualValues(t, 2, receipt["attempt"])
				require.Equal(t, "queued", readCard()["state"])
			}
		})
	}

	// Generation changes invalidate the same observed head without consuming
	// the foreign wait. A failed approval CAS rolls the branch effect back.
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=$2 WHERE id=$1`, item.ID, []byte(checks))
	require.NoError(t, err)
	requestDiscard := func(key string) string {
		raw := confirmationCall("/api/branches/smithers%2Fretry", ownerToken, "", fmt.Sprintf(`{"op":"discard-foreign","id":"foreign","revision":%q}`, head), key, 202, "")
		var result map[string]string
		require.NoError(t, json.Unmarshal([]byte(raw), &result))
		return result["confirmation"]
	}
	private := requestDiscard("private-discard")
	confirmationCall("/api/confirmations/"+private+"/approve", ownerToken, "", `{}`, "delegated-press", 403, "permission")
	confirmationCall("/api/confirmations/"+private+"/approve", "", memberCookie, `{}`, "other-member-press", 403, "permission")
	confirmationCall("/api/confirmations/"+private+"/deny", "", ownerCookie, `{}`, "person-cancel", 200, "")
	confirmationCall("/api/confirmations/"+private+"/approve", "", ownerCookie, `{}`, "after-cancel", 409, "confirmation_resolved")
	elapsed := requestDiscard("elapsed-discard")
	_, err = pool.Exec(ctx, `UPDATE approvals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, elapsed)
	require.NoError(t, err)
	confirmationCall("/api/confirmations/"+elapsed+"/approve", "", ownerCookie, `{}`, "elapsed-press", 409, "confirmation_resolved")
	var expired string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, elapsed).Scan(&expired))
	require.Equal(t, "expired", expired)
	bringRaw := confirmationCall("/api/confirmations", ownerToken, "", fmt.Sprintf(`{"command":"branch.bring-in","subject":{"kind":"branch","ref":"smithers/retry"},"payload":{"id":"foreign","revision":%q}}`, head), "generation-bring", 202, "")
	var bring map[string]string
	require.NoError(t, json.Unmarshal([]byte(bringRaw), &bring))
	stale := requestDiscard("generation-discard")
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET generation=generation+1 WHERE id=$1`, item.ID)
	require.NoError(t, err)
	stable, err := q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	confirmationCall("/api/confirmations/"+stale+"/approve", "", ownerCookie, `{}`, "generation-press", 409, "confirmation_resolved")
	confirmationCall("/api/confirmations/"+bring["confirmation"]+"/approve", "", ownerCookie, `{}`, "generation-bring-press", 409, "confirmation_resolved")
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, bring["confirmation"]).Scan(&expired))
	require.Equal(t, "expired", expired)
	unchanged, err = q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, stable, unchanged)
	retry := requestDiscard("rollback-discard")
	_, err = pool.Exec(ctx, `CREATE FUNCTION reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='approved' THEN RAISE EXCEPTION 'forced approval failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_confirmation BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_confirmation()`)
	require.NoError(t, err)
	confirmationCall("/api/confirmations/"+retry+"/approve", "", ownerCookie, `{}`, "rollback-press", 503, "todo_unavailable")
	unchanged, err = q.GetMythicalItem(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, stable, unchanged)
	var pendingState string
	require.NoError(t, pool.QueryRow(ctx, `SELECT state FROM approvals WHERE id=$1`, retry).Scan(&pendingState))
	require.Equal(t, "pending", pendingState)
	_, err = pool.Exec(ctx, `DROP TRIGGER reject_confirmation ON approvals`)
	require.NoError(t, err)
	confirmationCall("/api/confirmations/"+retry+"/approve", "", ownerCookie, `{}`, "rollback-press", 200, "")

}
