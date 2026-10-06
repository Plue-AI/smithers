package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestInstallScorecardOwnerReadsRealCreationReceipts(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	var owner, repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('scorecard-owner','scorecard-owner') RETURNING id`).Scan(&owner))
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, owner).Scan(&repo))
	_, err = q.RequestMythicalBootstrap(ctx, repo, owner, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"scorecard-owner","repository_name":"app","repository_id":%d}`, repo)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	person := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: owner}, SessionHash: "scorecard-session"})
	service := services.NewMythicalService(pool, nil)
	input := services.MythicalTodoInput{Title: "One", Prompt: "Change README", Request: "scorecard-create"}
	_, err = service.FileTodo(person, repo, owner, input)
	require.NoError(t, err)
	_, err = service.FileTodo(person, repo, owner, input)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("scorecard-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner, Username: "scorecard-owner", SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{InstallScorecard: composeInstallScorecard(cfg, q, pool)})
	for _, signedIn := range []bool{false, true} {
		req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2020-01-01T23:30:00-07:00&to=2030-01-01T23:30:00-07:00", nil)
		req.RemoteAddr = "127.0.0.1:61000"
		if signedIn {
			req.AddCookie(&http.Cookie{Name: "session", Value: "scorecard-cookie"})
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if !signedIn {
			require.Equal(t, 401, w.Code)
			continue
		}
		require.Equal(t, 200, w.Code, w.Body.String())
		require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
		var out services.Scorecard
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		require.Equal(t, float64(1), out.Measures["accepted"].Value)
		require.Equal(t, float64(0), out.Measures["dropped"].Value)
		require.Equal(t, "between", out.Measures["accepted"].Verdict)
		require.Equal(t, "source_missing", out.Measures["merged"].Verdict)
		require.Equal(t, "source_missing", out.Measures["multiplayer"].Verdict)
		require.Equal(t, services.ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, out.PersonMinutes)
		require.Equal(t, "2020-01-02T06:30:00Z", out.Window.From.Format(time.RFC3339))
	}
	// Literal persisted app frames: reasoning precedes the first answer;
	// private legacy turns and malformed frames must not move its timestamp.
	_, err = pool.Exec(ctx, `INSERT INTO chat_turns(id,repository_id,conversation_id,user_id,run_id,leg_id,request_hash,access_hash,state)
 VALUES('shared-answer',$1,'alice',$2,'shared-answer','one','request','access','running'),
 ('private-answer',$1,NULL,$2,'private-answer','one','request','access','completed');
 `, repo, owner)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes,created_at) VALUES
 ('shared-answer',1,1,'before','[{"type":"delta","kind":"reasoning","text":"thinking"}]','one',1,'2026-10-04T08:00:00Z'),
 ('shared-answer',2,2,'one','[{"type":"delta","kind":"text","text":"Answer"}]','two',1,'2026-10-04T08:01:00Z'),
 ('shared-answer',3,3,'two','[{"type":"delta","kind":"text","text":"More"}]','three',1,'2026-10-04T08:02:00Z'),
 ('shared-answer',4,4,'three','{}','four',1,'2026-10-04T07:00:00Z'),
 ('private-answer',1,1,'before','[{"type":"delta","kind":"text","text":"private"}]','private',1,'2026-10-04T06:00:00Z');`)
	require.NoError(t, err)
	request := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-03T23:30:00-07:00&to=2026-10-17T23:30:00-07:00", nil)
	request.RemoteAddr = "127.0.0.1:61000"
	request.AddCookie(&http.Cookie{Name: "session", Value: "scorecard-cookie"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var answerCard services.Scorecard
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &answerCard))
	require.Equal(t, "2026-10-04T08:01:00Z", answerCard.Measures["first_answer"].Value)
	require.Equal(t, "between", answerCard.Measures["first_answer"].Verdict)
	require.Empty(t, answerCard.Measures["first_answer"].MissingTickets)
	require.Equal(t, "source_missing", answerCard.Measures["install_start"].Verdict)

	// The composed handler uses the shared person-only authorizer. Refuse
	// eligible delegated credentials with never; run and machine authority
	// cannot become owner-person authority.
	for _, tc := range []struct {
		name string
		info *middleware.AuthInfo
		code string
	}{
		{"delegated", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "via:claude-code"}, "never"},
		{"personal token", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true}, "never"},
		{"run", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true}, "permission"},
		{"machine", &middleware.AuthInfo{User: &db.User{ID: owner}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "credential:sync"}, "permission"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seed := sha256.Sum256([]byte(tc.name))
			raw := "smithers_" + hex.EncodeToString(seed[:])[:40]
			hash := sha256.Sum256([]byte(raw))
			token, err := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner, Name: tc.name, TokenHash: hex.EncodeToString(hash[:]), TokenLastEight: hex.EncodeToString(hash[:])[56:], Scopes: tc.info.RawScopes, SystemIssued: tc.info.TokenSystemIssued, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
			require.NoError(t, err)
			var before string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(t)::text FROM access_tokens t WHERE id=$1`, token.ID).Scan(&before))
			var auditsBefore int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&auditsBefore))
			req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z", nil)
			req.RemoteAddr = "127.0.0.1:61000"
			req.Header.Set("Authorization", "Bearer "+raw)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			require.Equal(t, 403, w.Code, w.Body.String())
			var refusal struct {
				Code  string `json:"code"`
				Class string `json:"class"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &refusal))
			require.Equal(t, tc.code, refusal.Code)
			require.Equal(t, tc.code, refusal.Class)
			var after string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(t)::text FROM access_tokens t WHERE id=$1`, token.ID).Scan(&after))
			require.Equal(t, before, after)
			var auditsAfter int
			require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&auditsAfter))
			require.Equal(t, auditsBefore, auditsAfter)
		})
	}

	for _, permission := range []string{"write", "admin"} {
		t.Run(permission, func(t *testing.T) {
			var user int64
			require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, "scorecard-"+permission).Scan(&user))
			_, err := pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,$3)`, repo, user, permission)
			require.NoError(t, err)
			raw := "scorecard-" + permission + "-cookie"
			hash := sha256.Sum256([]byte(raw))
			_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: user, Username: "scorecard-" + permission, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
			require.NoError(t, err)
			var sessionBefore string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(s)::text FROM auth_sessions s WHERE session_key=$1`, hex.EncodeToString(hash[:])).Scan(&sessionBefore))
			req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z", nil)
			req.RemoteAddr = "127.0.0.1:61000"
			req.AddCookie(&http.Cookie{Name: "session", Value: raw})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			require.Equal(t, 403, w.Code, w.Body.String())
			var refusal struct {
				Code  string `json:"code"`
				Class string `json:"class"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &refusal))
			require.Equal(t, "permission", refusal.Code)
			require.Equal(t, "permission", refusal.Class)
			var sessionAfter string
			require.NoError(t, pool.QueryRow(ctx, `SELECT row_to_json(s)::text FROM auth_sessions s WHERE session_key=$1`, hex.EncodeToString(hash[:])).Scan(&sessionAfter))
			require.Equal(t, sessionBefore, sessionAfter)
		})
	}

	// State timestamps come from receipt transitions, not mutable item rows.
	var item string
	require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM mythical_items WHERE repository_id=$1`, repo).Scan(&item))
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE mythical_items SET state='cancelled',updated_at='2031-01-01T00:00:00Z' WHERE id=$1::uuid`, item)
	require.NoError(t, err)
	fact, _ := json.Marshal(map[string]any{"item": item})
	_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: "todo:" + item}, "00000000-0000-4000-8000-000000000001", "todo.dropped", "dropped", fact)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE product_job_events SET recorded_at='2026-10-04T08:03:00Z' WHERE operation_id='00000000-0000-4000-8000-000000000001'`)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	_, err = pool.Exec(ctx, `UPDATE product_job_events SET recorded_at='2026-10-04T06:30:00Z' WHERE principal_id=$1 AND event_type='todo.created'`, "todo:"+item)
	require.NoError(t, err)
	readState := func() services.Scorecard {
		request := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-10-03T23:30:00-07:00&to=2026-10-17T23:30:00-07:00", nil)
		request.RemoteAddr = "127.0.0.1:61000"
		request.AddCookie(&http.Cookie{Name: "session", Value: "scorecard-cookie"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		require.Equal(t, 200, response.Code, response.Body.String())
		var card services.Scorecard
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
		return card
	}
	require.Equal(t, float64(1), readState().Measures["dropped"].Value)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='queued' WHERE id=$1::uuid`, item)
	require.NoError(t, err)
	require.Equal(t, float64(0), readState().Measures["dropped"].Value)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET state='blocked' WHERE id=$1::uuid`, item)
	require.NoError(t, err)
	incomplete := readState()
	require.Equal(t, "source_missing", incomplete.Measures["failed"].Verdict)
	require.Equal(t, []string{"T-STK-01"}, incomplete.Measures["failed"].MissingTickets)
	require.Equal(t, float64(1), incomplete.Measures["accepted"].Value)

	// Direct GitHub merges use the same synced settlement receipt as app merges.
	// A duplicate delivery does not increase the count or delay first merge.
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `UPDATE mythical_items SET state='landed',updated_at='2031-01-01T00:00:00Z' WHERE id=$1::uuid`, item)
	require.NoError(t, err)
	mergedFact, _ := json.Marshal(map[string]any{"item": item, "source": "github", "pr": 1})
	for _, operation := range []string{"00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"} {
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: "todo:" + item}, operation, "todo.github_merged", "merged", mergedFact)
		require.NoError(t, err)
	}
	_, err = tx.Exec(ctx, `UPDATE product_job_events SET recorded_at=CASE WHEN operation_id='00000000-0000-4000-8000-000000000002' THEN '2026-10-04T08:04:00Z'::timestamptz ELSE '2026-10-04T08:05:00Z'::timestamptz END WHERE operation_id IN ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003')`)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	mergedCard := readState()
	require.Equal(t, float64(1), mergedCard.Measures["merged"].Value)
	require.Equal(t, "between", mergedCard.Measures["merged"].Verdict)
	require.Empty(t, mergedCard.Measures["merged"].MissingTickets)
	require.Equal(t, "2026-10-04T08:04:00Z", mergedCard.Measures["first_merge"].Value)
	require.Equal(t, float64(0), mergedCard.Measures["dropped"].Value)
	require.Equal(t, "source_missing", mergedCard.Measures["outside_work"].Verdict)
	require.Equal(t, []string{"T-GH-02"}, mergedCard.Measures["outside_work"].MissingTickets)
	require.Equal(t, "source_missing", mergedCard.Measures["dogfood"].Verdict)

	// Real T-COL-06 visit writer, including two sockets for one person. A
	// socket is not another session; a removed member's historical row stays
	// attributed to that person without consulting the current roster.
	var ben int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES('scorecard-ben','scorecard-ben') RETURNING id`).Scan(&ben))
	clock := time.Date(2026, 10, 5, 8, 0, 0, 0, time.UTC)
	visits := &presenceVisits{audit: services.NewAuditService(q), now: func() time.Time { return clock }}
	for _, day := range []int{5, 6, 12, 13} {
		start := time.Date(2026, 10, day, 8, 0, 0, 0, time.UTC)
		for elapsed := time.Duration(0); elapsed <= 2*time.Minute; elapsed += 20 * time.Second {
			clock = start.Add(elapsed)
			visits.heartbeat("app:todo-1", owner, "scorecard-owner", "alice-one")
			visits.heartbeat("app:todo-1", owner, "scorecard-owner", "alice-two")
			visits.heartbeat("app:todo-1", ben, "scorecard-ben", "ben")
		}
		visits.leave("app:todo-1", owner, "alice-one")
		visits.leave("app:todo-1", owner, "alice-two")
		visits.leave("app:todo-1", ben, "ben")
	}
	multiplayer := readState()
	require.Equal(t, map[string]any{"sessions": float64(8), "per_week": []any{float64(4), float64(4)}}, multiplayer.Measures["multiplayer"].Value)
	require.Equal(t, "pass", multiplayer.Measures["multiplayer"].Verdict)
	require.Empty(t, multiplayer.Measures["multiplayer"].MissingTickets)
	require.Equal(t, mergedCard.Measures["merged"], multiplayer.Measures["merged"])
	// Producer evidence outside the requested window establishes a measured
	// zero, while still distinguishing an empty, uninstrumented audit table.
	emptyRequest := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from=2026-11-01T00:00:00Z&to=2026-11-15T00:00:00Z", nil)
	emptyRequest.RemoteAddr = "127.0.0.1:61000"
	emptyRequest.AddCookie(&http.Cookie{Name: "session", Value: "scorecard-cookie"})
	emptyResponse := httptest.NewRecorder()
	router.ServeHTTP(emptyResponse, emptyRequest)
	require.Equal(t, 200, emptyResponse.Code, emptyResponse.Body.String())
	var emptyCard services.Scorecard
	require.NoError(t, json.Unmarshal(emptyResponse.Body.Bytes(), &emptyCard))
	require.Equal(t, map[string]any{"sessions": float64(0), "per_week": []any{float64(0), float64(0)}}, emptyCard.Measures["multiplayer"].Value)
	require.Equal(t, "kill", emptyCard.Measures["multiplayer"].Verdict)
	_, err = pool.Exec(ctx, `DELETE FROM audit_log WHERE event_type='presence' AND metadata->>'start'='2026-10-13T08:00:00Z'`)
	require.NoError(t, err)
	twoSessions := readState()
	require.Equal(t, map[string]any{"sessions": float64(6), "per_week": []any{float64(4), float64(2)}}, twoSessions.Measures["multiplayer"].Value)
	require.Equal(t, "between", twoSessions.Measures["multiplayer"].Verdict)
	_, err = pool.Exec(ctx, `DELETE FROM audit_log WHERE event_type='presence' AND metadata->>'start'='2026-10-12T08:00:00Z'`)
	require.NoError(t, err)
	zeroWeekTwo := readState()
	require.Equal(t, map[string]any{"sessions": float64(4), "per_week": []any{float64(4), float64(0)}}, zeroWeekTwo.Measures["multiplayer"].Value)
	require.Equal(t, "kill", zeroWeekTwo.Measures["multiplayer"].Verdict)
	// Malformed timestamps are data, never SQL casts that abort other reads.
	_, err = pool.Exec(ctx, `INSERT INTO audit_log(event_type,actor_id,actor_name,target_type,target_name,action,metadata,ip_address) VALUES('presence',$1,'scorecard-ben','branch','app:todo-1','visit','{"branch":"app:todo-1","member":0,"via":"app","start":"bad","end":"bad"}','')`, ben)
	require.NoError(t, err)
	incompletePresence := readState()
	require.Equal(t, "source_missing", incompletePresence.Measures["multiplayer"].Verdict)
	require.Equal(t, []string{"T-COL-06"}, incompletePresence.Measures["multiplayer"].MissingTickets)
	require.Equal(t, mergedCard.Measures["merged"], incompletePresence.Measures["merged"])
	require.Equal(t, services.ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, incompletePresence.PersonMinutes)

	setup := &services.InstallSetupService{Pool: pool, Now: func() time.Time {
		return time.Date(2026, 10, 4, 7, 16, 0, 0, time.UTC)
	}}
	require.NoError(t, setup.Initialize(ctx))
	startedCard := readState()
	require.Equal(t, "2026-10-04T07:16:00Z", startedCard.Measures["install_start"].Value)
	require.Equal(t, float64(48), startedCard.Measures["activation"].Value)
	require.Equal(t, "pass", startedCard.Measures["activation"].Verdict)
	setup.Now = func() time.Time { return time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC) }
	require.NoError(t, setup.Initialize(ctx))
	restartedCard := readState()
	require.Equal(t, startedCard.Measures["install_start"], restartedCard.Measures["install_start"])
	require.Equal(t, startedCard.Measures["activation"], restartedCard.Measures["activation"])
	// Missing legacy receipts are never backfilled from a restart. Malformed
	// receipts refuse just their measures and preserve available TODO counts.
	_, err = pool.Exec(ctx, `DELETE FROM install_settings WHERE key='setup.started_at'`)
	require.NoError(t, err)
	require.NoError(t, setup.Initialize(ctx))
	legacyCard := readState()
	require.Equal(t, "source_missing", legacyCard.Measures["install_start"].Verdict)
	require.Equal(t, []string{"T-INS-06"}, legacyCard.Measures["activation"].MissingTickets)
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES('setup.started_at','"malformed"')`)
	require.NoError(t, err)
	malformedStart := readState()
	require.Equal(t, "source_missing", malformedStart.Measures["install_start"].Verdict)
	require.Equal(t, mergedCard.Measures["merged"], malformedStart.Measures["merged"])
	// Independently missing providers must not abort the read-only snapshot
	// or erase unrelated receipts through the production HTTP boundary.
	for _, tc := range []struct {
		table, measure, ticket, preserved string
	}{
		{"product_job_events", "accepted", "T-STK-01", "first_answer"},
		{"mythical_items", "accepted", "T-STK-01", "first_answer"},
		{"chat_turns", "first_answer", "T-APP-16", "merged"},
		{"chat_turn_batches", "first_answer", "T-APP-16", "merged"},
		{"audit_log", "multiplayer", "T-COL-06", "merged"},
	} {
		t.Run("missing "+tc.table, func(t *testing.T) {
			// Names are fixed test literals, never request or repository data.
			_, err := pool.Exec(ctx, "ALTER TABLE "+tc.table+" RENAME TO scorecard_omitted_provider")
			require.NoError(t, err)
			defer func() {
				_, err := pool.Exec(ctx, "ALTER TABLE scorecard_omitted_provider RENAME TO "+tc.table)
				require.NoError(t, err)
			}()
			card := readState()
			require.Nil(t, card.Measures[tc.measure].Value)
			require.Equal(t, "source_missing", card.Measures[tc.measure].Verdict)
			require.Equal(t, []string{tc.ticket}, card.Measures[tc.measure].MissingTickets)
			require.Equal(t, malformedStart.Measures[tc.preserved], card.Measures[tc.preserved])
			require.Equal(t, services.ScorecardPersonMinutes{Source: "sampled_alpha_sessions", Verdict: "manual"}, card.PersonMinutes)
		})
	}

}
