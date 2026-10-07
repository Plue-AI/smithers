package services

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestConflictReservationSurvivesRestartPostgres(t *testing.T) {
	for _, limit := range []int{0, 1, 8} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			o := newMythicalOrchestration(t)
			ctx := t.Context()
			source := o.git(o.work, "rev-parse", "HEAD")
			require.NoError(t, o.service.queries().UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: InstallCodingProjectKey, Value: []byte(fmt.Sprintf(`{"conflictAttempts":%d}`, limit))}))
			item, _, err := o.service.queries().InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: o.repoID, State: "integrating", RequestRunID: "pinned-run", Checks: []byte(`{}`)})
			require.NoError(t, err)
			item.RequestRunID = "pinned-run"
			item, err = o.service.queries().SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			step := &mythicalItemStep{s: o.service, r: &mythicalRun{g: mythicalGit{dir: filepath.Join(o.work, ".git")}, row: db.MythicalStack{LandedMain: source}}}
			reservation, err := step.reserveConflict(ctx, item, "retained-change", "onto")
			require.NoError(t, err)
			require.Equal(t, limit, reservation.Limit)
			want := 1
			if limit == 0 {
				want = 0
			}
			require.Equal(t, want, reservation.Reserved)
			checks := mythicalChecksOf(item)
			checks.ConflictReservation = reservation
			item.Checks = checks.encode()
			item, err = o.service.queries().SaveMythicalItem(ctx, item)
			require.NoError(t, err)
			// A changed setting and a new service cannot replenish this binding.
			require.NoError(t, o.service.queries().UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: InstallCodingProjectKey, Value: []byte(`{"conflictAttempts":0}`)}))
			step.s = NewMythicalService(o.pool, nil)
			for range 10 {
				retained, err := step.s.queries().GetMythicalItem(ctx, item.ID)
				require.NoError(t, err)
				again, err := step.reserveConflict(ctx, retained, "retained-change", "onto")
				require.NoError(t, err)
				require.Equal(t, reservation, again)
			}
			require.Empty(t, o.launcher.all("todo"), "reservation is not an agent execution receipt")
		})
	}
}

type conflictValidationFake struct {
	calls []ConflictValidation
	paths []string
	err   error
}

func (f *conflictValidationFake) UnresolvedPaths(_ context.Context, input ConflictValidation) ([]string, error) {
	f.calls = append(f.calls, input)
	return f.paths, f.err
}

// Native inspection is a contract fake; these are PostgreSQL settlement and
// replay tests, not the microVM acceptance cases A-C.
func TestTodoConflictDoneRetainsBinding(t *testing.T) {
	o, session, launcher, item, launch := newAskingTodo(t)
	checks := mythicalChecksOf(item)
	checks.Rebase = &mythicalRebase{Onto: "onto", Name: "main", Since: o.service.now()}
	checks.Waits = []TodoWait{{ID: "conflict-1", Kind: "conflict", Paths: []string{"a.txt"}, ConflictChange: "change", OntoRevision: "onto", Since: o.service.now(),
		Signal: &TodoWaitSignal{Scope: launch.Scope, Target: launch.Target, Flow: "todo", Run: item.RequestRunID, Name: "conflict"}}}
	item.Checks = checks.encode()
	item.Integration = []byte(`{"conflict":{"head":"change","onto":"onto","paths":["a.txt"]}}`)
	var err error
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	_, err = o.pool.Exec(session, `UPDATE mythical_stacks SET landed_main='onto' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	input := TodoAnswerInput{Wait: "conflict-1", Answer: "done"}
	refused := func(code string) {
		t.Helper()
		var e *TodoControlError
		require.ErrorAs(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input), &e)
		require.Equal(t, code, e.Code)
		retained := o.byID(uuidString(item.ID))
		require.JSONEq(t, string(item.Checks), string(retained.Checks))
		require.JSONEq(t, string(item.Integration), string(retained.Integration))
		require.Equal(t, item.CandidateHead, retained.CandidateHead)
		require.Empty(t, launcher.sent())
	}
	refused("conflict_validation_unavailable")
	fake := &conflictValidationFake{paths: []string{"a.txt"}}
	o.service.SetConflictValidator(fake)
	refused("still_conflicted")
	require.Equal(t, ConflictValidation{Workspace: item.WorkspaceID, Change: "change", Onto: "onto", Run: item.RequestRunID, Digest: item.FlowDigest.String}, fake.calls[0])
	fake.err = errors.New("daemon disconnected")
	refused("conflict_validation_unavailable")
	fake.err = nil
	checks.Rebase.Onto = "new-target"
	item.Checks = checks.encode()
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	before := len(fake.calls)
	refused("stale_conflict")
	require.Len(t, fake.calls, before)
	checks.Rebase.Onto = "onto"
	item.Checks = checks.encode()
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	_, err = o.pool.Exec(session, `UPDATE mythical_stacks SET landed_main='new-main' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	before = len(fake.calls)
	refused("stale_conflict")
	require.Len(t, fake.calls, before)
	_, err = o.pool.Exec(session, `UPDATE mythical_stacks SET landed_main='onto' WHERE repository_id=$1`, o.repoID)
	require.NoError(t, err)
	fake.paths = nil
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.Len(t, launcher.sent(), 1)
	require.JSONEq(t, `"done"`, string(launcher.sent()[0].Payload))
	settled := mythicalChecksOf(o.byID(uuidString(item.ID))).Waits[0]
	require.NotNil(t, settled.SettledAt)
	require.Equal(t, "change", settled.ConflictChange)
	require.Equal(t, "onto", settled.OntoRevision)
	require.Equal(t, []string{"a.txt"}, settled.Paths)
	facts := o.facts(item, "todo.answered")
	require.Len(t, facts, 1)
	require.Equal(t, "conflict-1", facts[0]["wait"])
}
