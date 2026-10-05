package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/stretchr/testify/require"
)

func learningReadFixture() (db.MythicalItem, *middleware.AuthInfo) {
	item := db.MythicalItem{RepositoryID: 42, State: "landed", Number: pgtype.Int8{Int64: 7, Valid: true}, PRMergeCommit: strings.Repeat("a", 40), RequestRunID: "plan-1", VibeRunID: "code-1", Checks: mythicalChecks{Learning: &mythicalLearning{WorkspaceID: "learning-workspace", RunID: "learn-7", State: "running"}}.encode()}
	auth := &middleware.AuthInfo{IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "read:repository,repo:42,landing-workspace:learning-workspace"}
	return item, auth
}
func TestLearningReadBoundToStoredMachineAndRun(t *testing.T) {
	item, auth := learningReadFixture()
	require.NoError(t, learningReadBinding(auth, item, "learn-7"))
	for _, name := range []string{"nil", "person", "repository", "workspace", "run", "unmerged", "retired", "starting", "blank", "oversized"} {
		t.Run(name, func(t *testing.T) {
			current := item
			credential := *auth
			run := "learn-7"
			switch name {
			case "nil":
				require.Error(t, learningReadBinding(nil, current, run))
				return
			case "person":
				credential.TokenSystemIssued = false
			case "repository":
				credential.RawScopes = "read:repository,repo:43,landing-workspace:learning-workspace"
			case "workspace":
				credential.RawScopes = "read:repository,repo:42,landing-workspace:other"
			case "run":
				run = "other-run"
			case "unmerged":
				current.State = "proposed"
			case "retired":
				checks := mythicalChecksOf(current)
				checks.Learning.State = "completed"
				current.Checks = checks.encode()
			case "starting":
				checks := mythicalChecksOf(current)
				checks.Learning.RunID = ""
				current.Checks = checks.encode()
			case "blank":
				run = ""
			case "oversized":
				run = strings.Repeat("a", 513)
			}
			require.Error(t, learningReadBinding(&credential, current, run))
		})
	}
}
func TestLearningSnapshotPreservesDecisionsAndBoundsEvidence(t *testing.T) {
	item, _ := learningReadFixture()
	checks := mythicalChecksOf(item)
	checks.Steers = []todoSteer{{Text: "Keep the helper because it retries safely."}}
	now := time.Unix(1, 0)
	checks.Waits = []TodoWait{{Kind: "question", Prompt: "Root or src?", Answer: "Root, to keep imports stable.", AnsweredBy: "ben", SettledAt: &now}}
	checks.Attempts = []todoAttemptEvidence{{Attempt: 1, Items: []map[string]any{{"kind": "check", "name": "lint", "state": "failed"}, {"kind": "check", "name": "lint", "state": "failed"}}}}
	item.Checks = checks.encode()
	item.Summary = "Reused the helper."
	snapshot := learningSnapshotOf("owner/demo", item, []db.MythicalItem{item, item, {State: "proposed", Number: pgtype.Int8{Int64: 8, Valid: true}}})
	require.Equal(t, "merged", snapshot.State)
	require.Equal(t, "learn-7", snapshot.Run)
	require.Equal(t, []string{"plan-1", "code-1"}, snapshot.Attempts)
	require.Len(t, snapshot.Journal, 3)
	require.Equal(t, "control.agent.steering-drained", snapshot.Journal[0].EventType)
	require.Equal(t, map[string]any{"messages": []any{map[string]any{"role": "user", "text": "Keep the helper because it retries safely."}}}, snapshot.Journal[0].Payload)
	require.Len(t, snapshot.Outcomes, 1)
	require.Equal(t, []LearningFailure{{Signature: "check:lint@verify", Text: "lint failed at verify"}}, snapshot.Outcomes[0].Failures)
	checks.Steers = make([]todoSteer, 140)
	for i := range checks.Steers {
		checks.Steers[i].Text = strings.Repeat("界", 20000)
	}
	item.Checks = checks.encode()
	bounded := learningSnapshotOf("owner/demo", item, make([]db.MythicalItem, 40))
	require.Len(t, bounded.Journal, 128)
	raw, err := json.Marshal(bounded)
	require.NoError(t, err)
	require.Less(t, len(raw), 2<<20)
}
func TestLearningSnapshotRealDatabaseReadAndCancellation(t *testing.T) {
	o, session := newTodoAdmission(t)
	item := o.fileTodo(session, "learning-reader")
	item = mythicalLanded(item, o.landedMain(), o.service.now())
	checks := mythicalChecksOf(item)
	checks.Steers = []todoSteer{{Text: "Reuse the helper because it bounds retries."}}
	checks.Learning = &mythicalLearning{WorkspaceID: "learning-workspace", RunID: "learn-reader", State: "running"}
	item.Checks = checks.encode()
	_, err := db.New(o.pool).SaveMythicalItem(context.Background(), item)
	require.NoError(t, err)
	auth := &middleware.AuthInfo{IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "read:repository," + middleware.RepositoryRestrictionScope(o.repoID) + "," + middleware.LandingWorkspaceScope("learning-workspace")}
	ctx := middleware.ContextWithAuthInfo(context.Background(), auth)
	snapshot, err := o.service.LearningSnapshot(ctx, o.repoID, item.Number.Int64, "learn-reader")
	require.NoError(t, err)
	require.Equal(t, item.PRMergeCommit, snapshot.Commit)
	require.Equal(t, item.Number.Int64, snapshot.Todo)
	require.NotEmpty(t, snapshot.Journal)
	repeated, err := o.service.LearningSnapshot(ctx, o.repoID, item.Number.Int64, "learn-reader")
	require.NoError(t, err)
	require.Equal(t, snapshot, repeated)
	_, err = o.service.LearningSnapshot(ctx, o.repoID, item.Number.Int64, "other")
	require.Error(t, err)
	cancelled, stop := context.WithCancel(ctx)
	stop()
	_, err = o.service.LearningSnapshot(cancelled, o.repoID, item.Number.Int64, "learn-reader")
	require.Error(t, err)
	require.Equal(t, "merged", todoState(o.byID(uuidString(item.ID))))
}
func FuzzLearningSnapshotBounded(f *testing.F) {
	f.Add("Keep the helper", "lint", uint8(3))
	f.Fuzz(func(t *testing.T, text, name string, count uint8) {
		if len(text)+len(name) > 64<<10 {
			return
		}
		item, _ := learningReadFixture()
		checks := mythicalChecksOf(item)
		for i := 0; i < int(count); i++ {
			checks.Steers = append(checks.Steers, todoSteer{Text: text})
		}
		checks.Attempts = []todoAttemptEvidence{{Attempt: 1, Items: []map[string]any{{"kind": "check", "name": name, "state": "failed"}}}}
		item.Checks = checks.encode()
		snapshot := learningSnapshotOf("owner/demo", item, []db.MythicalItem{item})
		require.LessOrEqual(t, len(snapshot.Journal), 128)
		require.LessOrEqual(t, len(snapshot.Outcomes), 20)
		raw, err := json.Marshal(snapshot)
		require.NoError(t, err)
		require.True(t, json.Valid(raw))
		require.Less(t, len(raw), 2<<20)
	})
}
