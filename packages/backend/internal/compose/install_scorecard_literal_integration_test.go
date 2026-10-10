package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// C-REL-04 step 1, 2 and 5 on real PostgreSQL through the production router,
// its credential middleware and the owner-person authorizer. Each source is
// persisted by its owning writer, or as that writer's literal receipt, with
// fixed ids and duplicate deliveries. The expected JSON in
// testdata/scorecard is hand-computed; the derivation is in the comments.
//
// t0 is 2026-10-03 23:30 in the install's time zone (-07:00), 06:30 UTC.
// Weeks 1-2 hold 60 accepted TODOs, 30 a week; week 3 holds 11.
//   - 52 merge on GitHub at accepted+48 min; TODO 0's merge is delivered twice.
//     TODO 51 is dropped, reopened and then merged: merged only.
//     TODO 52 is dropped and TODO 53 failed.
//   - Install start t0 and first merge t0+48 min: activation 48, pass.
//   - Person bursts on merged TODOs 1-9; TODOs 1-6 by terminal or ssh: 6
//     terminal edits. TODO 1's burst is delivered twice. An agent burst sits
//     beside Ben's on TODO 4's branch and TODO 10 has only an agent burst:
//     52 - 9 = 43 merged with no hand-written code, 82.7 %.
//   - Ben is a member other than the TODOs' owner Alice: 6 bursts, 1 answer
//     delivered twice and 1 approved review are 8 second-member actions. He
//     is removed mid-window; his history stays his.
//   - Two flow versions became Active; a stale load and a failed load did not.
//   - Alice and Ben share a branch in 3 separate intervals each week, then 4
//     in week 3, one of them with Carol too.
//   - The learning proposal TODO 20 merges; its signature failed in 3 of the
//     5 TODOs before and 0 of the 5 after: 1 that measurably helps.
//   - No synced main-commit inventory exists, so the laptop commit has no
//     row: outside work and dogfood name T-GH-02, never 0 or pass.
func TestInstallScorecardLiteralAlphaFixture(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user := func(name string) int64 {
		var id int64
		require.NoError(t, pool.QueryRow(ctx, `INSERT INTO users(username,lower_username) VALUES($1,$1) RETURNING id`, name).Scan(&id))
		return id
	}
	alice, ben, carol := user("alice"), user("ben"), user("carol")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, alice)
	require.NoError(t, err)
	var repo int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name) VALUES($1,'app','app') RETURNING id`, alice).Scan(&repo))
	_, err = q.RequestMythicalBootstrap(ctx, repo, alice, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo)
	require.NoError(t, err)
	for _, member := range []int64{ben, carol} {
		_, err = pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission) VALUES($1,$2,'write')`, repo, member)
		require.NoError(t, err)
	}
	binding := fmt.Sprintf(`{"owner_login":"alice","repository_name":"app","repository_id":%d}`, repo)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(binding)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(binding[:len(binding)-1] + `,"last_access_check_at":"2026-10-05T10:00:00Z"}`)}))
	cookie := sha256.Sum256([]byte("alpha-owner-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: alice, Username: "alice", SessionKey: hex.EncodeToString(cookie[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.AllowedOrigins = []string{"http://localhost:4000"}
	router := githubAppSetupComposeRouter(cfg, pool, nil, routerExtras{InstallScorecard: composeInstallScorecard(cfg, q, pool)})
	read := func(from, to string) string {
		req := httptest.NewRequest("GET", "http://localhost:4000/api/install/scorecard?from="+from+"&to="+to, nil)
		req.RemoteAddr = "127.0.0.1:61000"
		req.AddCookie(&http.Cookie{Name: "session", Value: "alpha-owner-cookie"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		require.Equal(t, 200, w.Code, w.Body.String())
		return w.Body.String()
	}
	// Step 5: both boundaries fall at 23:30 in the install's time zone.
	weeks12 := func() string { return read("2026-10-03T23:30:00-07:00", "2026-10-17T23:30:00-07:00") }
	week3 := func() string { return read("2026-10-17T23:30:00-07:00", "2026-10-24T23:30:00-07:00") }
	measure := func(body, name string) services.ScorecardMeasure {
		var card services.Scorecard
		require.NoError(t, json.Unmarshal([]byte(body), &card))
		return card.Measures[name]
	}
	expected := func(name string) string {
		raw, err := os.ReadFile("testdata/scorecard/" + name)
		require.NoError(t, err)
		return string(raw)
	}
	t0 := time.Date(2026, 10, 4, 6, 30, 0, 0, time.UTC)
	at := func(event jobs.Event, when time.Time) {
		_, err := pool.Exec(ctx, `UPDATE product_job_events SET recorded_at=$2 WHERE event_id=$1`, event.EventID, when)
		require.NoError(t, err)
	}
	fact := func(scope string, event, state string, data map[string]any, when time.Time) jobs.Event {
		raw, err := json.Marshal(data)
		require.NoError(t, err)
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		recorded, err := jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repo), PrincipalID: scope}, uuid.NewString(), event, state, raw)
		require.NoError(t, err)
		require.NoError(t, tx.Commit(ctx))
		at(recorded, when)
		return recorded
	}

	// S1: T-INS-06 setup receipt and T-APP-16's first persisted answer text.
	require.NoError(t, (&services.InstallSetupService{Pool: pool, Now: func() time.Time { return t0 }}).Initialize(ctx))
	_, err = pool.Exec(ctx, `INSERT INTO chat_turns(id,repository_id,conversation_id,user_id,run_id,leg_id,request_hash,access_hash,state)
 VALUES('alpha-answer',$1,'alice',$2,'alpha-answer','one','request','access','completed')`, repo, alice)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes,created_at) VALUES
 ('alpha-answer',1,1,'before','[{"type":"delta","kind":"reasoning","text":"thinking"}]','one',1,'2026-10-04T06:33:00Z'),
 ('alpha-answer',2,2,'one','[{"type":"delta","kind":"text","text":"Answer"}]','two',1,'2026-10-04T06:35:00Z')`)
	require.NoError(t, err)

	// S1: T-STK-01 creation receipts through the real writer, then each
	// TODO's lifecycle receipts in the order their writers emit them.
	person := middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: alice}, SessionHash: hex.EncodeToString(cookie[:])})
	stack := services.NewMythicalService(pool, nil)
	type todo struct {
		id       string
		number   int64
		accepted time.Time
	}
	todos := make([]todo, 71)
	for i := range todos {
		accepted := t0.Add(time.Duration(i) * time.Hour)
		if i >= 30 {
			accepted = t0.Add(7*24*time.Hour + time.Duration(i-30)*time.Hour)
		}
		if i >= 60 {
			accepted = t0.Add(14*24*time.Hour + time.Duration(i-60)*time.Hour)
		}
		input := services.MythicalTodoInput{Title: fmt.Sprintf("TODO %d", i), Prompt: "Change README", Request: fmt.Sprintf("alpha-%d", i)}
		created, err := stack.FileTodo(person, repo, alice, input)
		require.NoError(t, err)
		if i == 0 { // A repeated request is the same TODO.
			again, err := stack.FileTodo(person, repo, alice, input)
			require.NoError(t, err)
			require.Equal(t, created.Number, again.Number)
		}
		todos[i] = todo{number: created.Number, accepted: accepted}
		require.NoError(t, pool.QueryRow(ctx, `SELECT id::text FROM mythical_items WHERE repository_id=$1 AND number=$2`, repo, created.Number).Scan(&todos[i].id))
		_, err = pool.Exec(ctx, `UPDATE product_job_events SET recorded_at=$2 WHERE principal_id=$1 AND event_type='todo.created'`, "todo:"+todos[i].id, accepted)
		require.NoError(t, err)
	}
	item := func(i int) string { return "todo:" + todos[i].id }
	setState := func(i int, state string) {
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET state=$2 WHERE id=$1::uuid`, todos[i].id, state)
		require.NoError(t, err)
	}
	// Ben answers TODO 11's question; the answer is delivered twice and
	// carries the delegated sponsor, which never replaces the person.
	wait, err := json.Marshal([]map[string]any{{"id": "alpha-wait-11", "kind": "question", "since": todos[11].accepted.Add(15 * time.Minute),
		"settled_at": todos[11].accepted.Add(20 * time.Minute), "answer": "Yes", "answered_by": "ben"}})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{waits}',$2::jsonb) WHERE id=$1::uuid`, todos[11].id, wait)
	require.NoError(t, err)
	for range 2 {
		fact(item(11), "todo.answered", "queued", map[string]any{"item": todos[11].id, "wait": "alpha-wait-11",
			"actor": map[string]any{"kind": "person", "id": ben, "login": "ben"}, "by": map[string]any{"agent": "coding", "run": "delegated-sponsor"}},
			todos[11].accepted.Add(20*time.Minute))
	}
	fact(item(51), "todo.dropped", "dropped", map[string]any{"item": todos[51].id}, todos[51].accepted.Add(10*time.Minute))
	fact(item(51), "todo.state_changed", "queued", map[string]any{"item": todos[51].id}, todos[51].accepted.Add(15*time.Minute))
	for i := 0; i < 52; i++ {
		setState(i, "landed")
		merged := map[string]any{"item": todos[i].id, "source": "github", "pr": 100 + i}
		fact(item(i), "todo.github_merged", "merged", merged, todos[i].accepted.Add(48*time.Minute))
		if i == 0 {
			fact(item(i), "todo.github_merged", "merged", merged, todos[i].accepted.Add(49*time.Minute))
		}
	}
	setState(52, "cancelled")
	fact(item(52), "todo.dropped", "dropped", map[string]any{"item": todos[52].id}, todos[52].accepted.Add(30*time.Minute))
	setState(53, "blocked")
	fact(item(53), "todo.state_changed", "failed", map[string]any{"item": todos[53].id}, todos[53].accepted.Add(30*time.Minute))

	// Review & merge confirmations: Ben approves TODO 12, his TODO 13
	// confirmation is still pending and Alice approves her own TODO 14.
	for _, review := range []struct {
		id      string
		todo    int
		member  int64
		decided bool
	}{{"00000000-0000-4000-8000-000000000012", 12, ben, true}, {"00000000-0000-4000-8000-000000000013", 13, ben, false}, {"00000000-0000-4000-8000-000000000014", 14, alice, true}} {
		created := todos[review.todo].accepted.Add(30 * time.Minute)
		_, err = pool.Exec(ctx, `INSERT INTO approvals(id,repository_id,state,kind,title,member_id,credential_id,command,subject,revision,generation,reviewed_head_sha,created_at,expires_at)
 VALUES($1,$2,'pending','review_merge','Review & merge',$3,'delegated-request','merge',jsonb_build_object('kind','todo','ref',$4::text),'review-revision',1,repeat('a',40),$5,'2030-01-01T00:00:00Z')`,
			review.id, repo, review.member, fmt.Sprintf("T%d", todos[review.todo].number), created)
		require.NoError(t, err)
		if review.decided {
			_, err = pool.Exec(ctx, `UPDATE approvals SET state='approved',decided_at=$2,decided_by=$3,decision_credential='person-session',decision_key=$4 WHERE id=$1::uuid`,
				review.id, created.Add(5*time.Minute), review.member, "press-"+review.id)
			require.NoError(t, err)
		}
	}

	// T-FLW-03: the flow-load writer's own statements. Two versions became
	// Active; a stale load's version never did and a failed one never can.
	_, err = q.EnsureFlowLoad(ctx, repo)
	require.NoError(t, err)
	version := func(digest, commit, status, loadError string, activate bool) {
		tx, err := pool.Begin(ctx)
		require.NoError(t, err)
		defer tx.Rollback(ctx)
		inserted, err := db.New(tx).InsertFlowVersion(ctx, repo, "todo", "flows/todo/flow.ts", commit, digest, status, loadError, json.RawMessage(`{"steps":[]}`))
		require.NoError(t, err)
		require.True(t, inserted)
		if activate {
			moved, err := db.New(tx).ActivateFlowVersion(ctx, repo, "todo", digest)
			require.NoError(t, err)
			require.True(t, moved)
		}
		require.NoError(t, tx.Commit(ctx))
	}
	stamp := func(digest string, created, updated time.Time) {
		_, err := pool.Exec(ctx, `UPDATE workflow_definitions SET created_at=$3,updated_at=$4 WHERE repository_id=$1 AND digest=$2`, repo, digest, created, updated)
		require.NoError(t, err)
	}
	v1, v2, stale, broken := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64)
	version(v1, strings.Repeat("a", 40), "loaded", "", true)
	stamp(v1, t0.Add(2*24*time.Hour), t0.Add(2*24*time.Hour))
	version(v2, strings.Repeat("b", 40), "loaded", "", true)
	stamp(v1, t0.Add(2*24*time.Hour), t0.Add(9*24*time.Hour))
	stamp(v2, t0.Add(9*24*time.Hour), t0.Add(9*24*time.Hour))
	version(stale, strings.Repeat("c", 40), "loaded", "", false)
	stamp(stale, t0.Add(10*24*time.Hour), t0.Add(10*24*time.Hour))
	version(broken, strings.Repeat("d", 40), "failed", "typecheck failed", false)
	stamp(broken, t0.Add(11*24*time.Hour), t0.Add(11*24*time.Hour))
	// Version rows without a finished load are not producer coverage.
	unloaded := weeks12()
	require.Equal(t, "source_missing", measure(unloaded, "flow_revisions").Verdict)
	require.Equal(t, []string{"T-FLW-03"}, measure(unloaded, "flow_revisions").MissingTickets)
	require.Equal(t, float64(60), measure(unloaded, "accepted").Value)
	_, err = pool.Exec(ctx, `UPDATE flow_loads SET commit_id=$2,loaded_commit=$2 WHERE repository_id=$1`, repo, strings.Repeat("d", 40))
	require.NoError(t, err)

	// Step 2: only the S1 source contract. Without burst_files and without
	// presence or learning producer evidence those measures name their
	// tickets, while every S1 measure keeps its literal value.
	_, err = pool.Exec(ctx, `ALTER TABLE burst_files RENAME TO alpha_hidden_burst_files`)
	require.NoError(t, err)
	require.JSONEq(t, expected("weeks-1-2-s1.json"), weeks12())
	_, err = pool.Exec(ctx, `ALTER TABLE alpha_hidden_burst_files RENAME TO burst_files`)
	require.NoError(t, err)

	// S2: T-COL-04 canonical branch bursts with their file receipts.
	burst := func(i int, id, kind, via, run, agentKind string, member int64, when time.Time) {
		branch := fmt.Sprintf("alpha-branch-%d", i)
		_, err := pool.Exec(ctx, `UPDATE mythical_items SET workspace_id=$2 WHERE id=$1::uuid`, todos[i].id, branch)
		require.NoError(t, err)
		recorded := fact("branch:"+branch, "branch.burst", "completed", map[string]any{"id": id, "source_key": id, "kind": "burst",
			"actor": map[string]any{"kind": kind, "member_id": member, "via": via, "run": run, "agent_kind": agentKind}}, when)
		_, err = pool.Exec(ctx, `INSERT INTO burst_files(event_id,path,change) VALUES($1,'README.md','modified'),($1,'docs/a.md','added')`, recorded.EventID)
		require.NoError(t, err)
	}
	for _, edit := range []struct {
		todo   int
		via    string
		member int64
	}{{1, "terminal", ben}, {2, "terminal", ben}, {3, "ssh", ben}, {4, "terminal", ben}, {5, "terminal", alice}, {6, "ssh", alice}, {7, "web", ben}, {8, "cli", alice}, {9, "web", ben}} {
		burst(edit.todo, fmt.Sprintf("alpha-burst-%d", edit.todo), "person", edit.via, "", "", edit.member, todos[edit.todo].accepted.Add(10*time.Minute))
	}
	burst(1, "alpha-burst-1", "person", "terminal", "", "", ben, todos[1].accepted.Add(11*time.Minute))
	burst(4, "alpha-agent-4", "agent", "terminal", "alpha-run-4", "external", alice, todos[4].accepted.Add(12*time.Minute))
	burst(10, "alpha-agent-10", "agent", "agent", "alpha-run-10", "coding", alice, todos[10].accepted.Add(12*time.Minute))

	// S2: T-COL-06's visit writer. Alice and Ben share a branch on separate
	// days; Alice's second socket and a solo visit are no extra session.
	clock := t0
	visits := &presenceVisits{audit: services.NewAuditService(q), now: func() time.Time { return clock }}
	visit := func(day time.Time, people ...int64) {
		names := map[int64]string{alice: "alice", ben: "ben", carol: "carol"}
		for elapsed := time.Duration(0); elapsed <= 3*time.Minute; elapsed += 20 * time.Second {
			clock = day.Add(elapsed)
			for _, member := range people {
				visits.heartbeat("app:alpha", member, names[member], names[member])
			}
			if day.Day() == 5 {
				visits.heartbeat("app:alpha", alice, "alice", "alice-second-tab")
			}
		}
		for _, member := range people {
			visits.leave("app:alpha", member, names[member])
		}
		visits.leave("app:alpha", alice, "alice-second-tab")
	}
	for _, day := range []int{5, 6, 7, 12, 13, 14, 19, 20, 21, 22} {
		people := []int64{alice, ben}
		if day == 19 {
			people = append(people, carol)
		}
		visit(time.Date(2026, 10, day, 8, 0, 0, 0, time.UTC), people...)
	}
	visit(time.Date(2026, 10, 8, 8, 0, 0, 0, time.UTC), alice)
	_, err = pool.Exec(ctx, `DELETE FROM collaborators WHERE repository_id=$1 AND user_id=$2`, repo, ben)
	require.NoError(t, err)

	// S3: T-FLW-06's accepted learning note for TODO 20 and the attempt
	// evidence of the 5 TODOs on each side of its merge.
	for i := 15; i <= 25; i++ {
		failures := []map[string]string{}
		if i <= 17 {
			failures = append(failures, map[string]string{"signature": "check:unit@check", "text": "Check unit failed."})
		}
		attempts, err := json.Marshal([]map[string]any{{"attempt": 1, "run_id": fmt.Sprintf("alpha-attempt-%d", i), "outcome": "completed", "items": []any{}, "failures": failures}})
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `UPDATE mythical_items SET checks=jsonb_set(checks,'{attempts}',$2::jsonb) WHERE id=$1::uuid`, todos[i].id, attempts)
		require.NoError(t, err)
	}
	note, err := json.Marshal(services.LearningProposalNote{Repository: "alice/app", Run: "alpha-learning-run", LearningProposal: services.LearningProposal{Signature: "check:unit@check", Title: "Run unit checks", Prompt: "Update todo flow", Diff: "flows/todo/flow.ts"}})
	require.NoError(t, err)
	acceptedAt := todos[20].accepted.Add(10 * time.Minute).UnixMilli()
	_, err = pool.Exec(ctx, `INSERT INTO memory_notes(id,namespace_kind,namespace_id,text,tags_json,provenance_json,status,created_at_ms,status_at_ms,accepted_todo) VALUES('alpha-learning','flow',$1,'Run unit checks','[]',$2,'accepted',$3,$3,$4)`,
		fmt.Sprintf("learning:%d", repo), string(note), acceptedAt, fmt.Sprint(todos[20].number))
	require.NoError(t, err)

	// Step 1: weeks 1-2 and week 3, field for field.
	full := weeks12()
	require.JSONEq(t, expected("weeks-1-2.json"), full)
	require.JSONEq(t, expected("week-3.json"), week3())

	// Step 6: an absent version table refuses flow revisions only.
	_, err = pool.Exec(ctx, `ALTER TABLE workflow_definitions RENAME TO alpha_hidden_versions`)
	require.NoError(t, err)
	hidden := weeks12()
	_, err = pool.Exec(ctx, `ALTER TABLE alpha_hidden_versions RENAME TO workflow_definitions`)
	require.NoError(t, err)
	require.Equal(t, "source_missing", measure(hidden, "flow_revisions").Verdict)
	require.Equal(t, []string{"T-FLW-03"}, measure(hidden, "flow_revisions").MissingTickets)
	for _, name := range []string{"merged", "terminal_edits", "multiplayer", "self_improvement"} {
		require.Equal(t, measure(full, name), measure(hidden, name), name)
	}
}
