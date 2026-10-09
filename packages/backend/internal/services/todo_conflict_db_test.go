package services

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
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
	onto := o.hostRef("refs/heads/main")
	checks := mythicalChecksOf(item)
	checks.Rebase = &mythicalRebase{Onto: onto, Name: "main", Since: o.service.now()}
	checks.Waits = []TodoWait{{ID: "conflict-1", Kind: "conflict", Paths: []string{"a.txt"}, ConflictChange: "change", OntoRevision: onto, Since: o.service.now(),
		Signal: &TodoWaitSignal{Scope: launch.Scope, Target: launch.Target, Flow: "todo", Run: item.RequestRunID, Name: "conflict"}}}
	item.Checks = checks.encode()
	item.Integration = []byte(fmt.Sprintf(`{"conflict":{"head":"change","onto":"%s","paths":["a.txt"]}}`, onto))
	var err error
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	_, err = o.pool.Exec(session, `UPDATE mythical_stacks SET landed_main='older-fold-receipt' WHERE repository_id=$1`, o.repoID)
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
	fake := &preparingConflictValidationFake{conflictValidationFake: conflictValidationFake{paths: []string{"a.txt"}}}
	o.service.SetConflictValidator(fake)
	refused("still_conflicted")
	require.Equal(t, ConflictValidation{Workspace: item.WorkspaceID, Change: "change", Onto: onto, Run: item.RequestRunID, Digest: item.FlowDigest.String}, fake.calls[0])
	fake.err = errors.New("daemon disconnected")
	refused("conflict_validation_unavailable")
	fake.err = nil
	checks.Rebase.Onto = "new-target"
	item.Checks = checks.encode()
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	before := len(fake.calls)
	prepared := len(fake.prepared)
	refused("stale_conflict")
	require.Len(t, fake.calls, before)
	require.Len(t, fake.prepared, prepared, "a stale target must not reconnect or reconcile the daemon")
	checks.Rebase.Onto = onto
	item.Checks = checks.encode()
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	o.git(o.hostDir, "update-ref", "refs/heads/main", onto+"^")
	err = o.host.ImportRefs(session, "", "")
	require.NoError(t, err)
	before = len(fake.calls)
	refused("stale_conflict")
	require.Len(t, fake.calls, before)
	o.git(o.hostDir, "update-ref", "refs/heads/main", onto)
	err = o.host.ImportRefs(session, "", "")
	require.NoError(t, err)
	fake.paths = nil
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.Len(t, launcher.sent(), 1)
	require.JSONEq(t, `"done"`, string(launcher.sent()[0].Payload))
	settled := mythicalChecksOf(o.byID(uuidString(item.ID))).Waits[0]
	require.NotNil(t, settled.SettledAt)
	require.Equal(t, "change", settled.ConflictChange)
	require.Equal(t, onto, settled.OntoRevision)
	require.Equal(t, []string{"a.txt"}, settled.Paths)
	facts := o.facts(item, "todo.answered")
	require.Len(t, facts, 1)
	require.Equal(t, "conflict-1", facts[0]["wait"])
}

// Done can reach a live repair just before its failed terminal checkpoint.
// Native validation has already succeeded; that later failure must preserve
// the person's authority to finish capture without asking them to press again.
func TestConflictDoneBeforeRepairFailureRetainsCaptureAuthority(t *testing.T) {
	o, session, launcher, item, launch := newAskingTodo(t)
	onto := o.hostRef("refs/heads/main")
	checks := mythicalChecksOf(item)
	checks.Rebase = &mythicalRebase{Onto: onto, Native: &machined.RewriteResult{Head: "change", Paths: []string{"a.txt"}, Inspected: true}}
	checks.ConflictReservation = &todoConflictReservation{Run: item.RequestRunID, Change: "change", Onto: onto, Dispatched: true, ResolutionRun: "repair", Limit: 1, Reserved: 1}
	item.State, item.Reason = "integrating", "rebase_conflict_pending"
	item.Integration = []byte(fmt.Sprintf(`{"conflict":{"head":"change","onto":"%s","paths":["a.txt"]}}`, onto))
	item.Checks = checks.encode()
	// The stable wait identity is shared by live and terminal repair views.
	checks.ConflictReservation.Outcome = "failed: repair"
	item.Checks = checks.encode()
	wait, ok := manualConflictWait(item, o.service.now())
	require.True(t, ok)
	checks.ConflictReservation.Outcome = ""
	wait.Signal = &TodoWaitSignal{Scope: launch.Scope, Target: launch.Target, Flow: "coding/rebase-conflict", Run: "repair", Name: "conflict"}
	checks.Waits = []TodoWait{wait}
	item.Checks = checks.encode()
	var err error
	item, err = o.service.queries().SaveMythicalItem(session, item)
	require.NoError(t, err)
	o.service.SetConflictValidator(&conflictValidationFake{})
	input := TodoAnswerInput{Wait: wait.ID, Answer: "done"}
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.NoError(t, o.service.AnswerTodo(session, o.repoID, o.userID, item.Number.Int64, input))
	require.Len(t, launcher.sent(), 1)
	answered := o.byID(uuidString(item.ID))
	done := mythicalChecksOf(answered).ConflictReservation.Done
	require.NotNil(t, done)
	require.Equal(t, item.CandidateHead, done.Head)
	require.Equal(t, item.Generation, done.Generation)
	require.Equal(t, o.userID, done.User)
	next := answered
	update := flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Scope: launch.Scope, Checkpoint: flowdispatch.RuntimeCheckpoint{FlowID: "coding/rebase-conflict", Target: launch.Target, FailureCode: "runtime_catalog_unavailable"}}
	require.True(t, mythicalProjectRun(&next, answered, mythicalProjection{Phase: "conflict"}, update, "repair", true))
	for range 10 {
		projectManualConflictWait(&next, o.service.now())
	}
	retained := mythicalChecksOf(next)
	require.Equal(t, done, retained.ConflictReservation.Done)
	require.Equal(t, "todo.answer", retained.ConflictReservation.DoneCommand)
	require.NotNil(t, retained.Waits[0].SettledAt)
	require.Nil(t, retained.Waits[0].Signal)
	require.Equal(t, "done", retained.Waits[0].Answer)
	require.Equal(t, 1, retained.ConflictReservation.Reserved)
	require.Empty(t, todoOpenWaits(next))
}

// Native startup is mocked only for transaction ordering; the composed
// rehearsal independently proves real restart/reconciliation and Done.
type preparingConflictValidationFake struct {
	conflictValidationFake
	prepared []ConflictValidation
}

func (f *preparingConflictValidationFake) PrepareConflictValidation(_ context.Context, in ConflictValidation) error {
	f.prepared = append(f.prepared, in)
	return nil
}
