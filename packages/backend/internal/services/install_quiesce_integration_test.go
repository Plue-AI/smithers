package services

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The freeze gate of C-REL-06 against PostgreSQL: the durable freeze row in
// install_settings, the machine step over real machine rows, and reopening.
// Admission, the flow runtime and the persistence barriers are recording
// providers, because their tickets have not composed production ones.

type quiesceInstall struct {
	*quiesceMachines
	state   string
	calls   *[]string
	quiesce *InstallQuiesce
}

// compose builds the quiesce service the way a backend process does at start,
// over the same database and state root. Calling it again is a restart.
func (f *quiesceInstall) compose() *InstallQuiesce {
	steps := quiesceSteps{calls: f.calls}
	service := NewInstallQuiesce(&QuiesceGate{Store: InstallQuiesceStore{Pool: f.pool}, StateDir: f.state})
	service.Machines, service.Admission, service.Host, service.Barriers = f.service, steps, steps, barrierFixtures(f.calls, "")
	return service
}

func newQuiesceInstall(t *testing.T) *quiesceInstall {
	t.Helper()
	calls := []string{}
	f := &quiesceInstall{quiesceMachines: newQuiesceMachines(t), state: t.TempDir(), calls: &calls}
	f.quiesce = f.compose()
	return f
}

// freezeRow is the durable freeze, or nil when the install is open.
func (f *quiesceInstall) freezeRow(t *testing.T) *QuiesceFreeze {
	t.Helper()
	var raw []byte
	err := f.pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key='quiesce'`).Scan(&raw)
	if err != nil {
		require.ErrorContains(t, err, "no rows")
		return nil
	}
	row := &QuiesceFreeze{}
	require.NoError(t, json.Unmarshal(raw, row))
	return row
}

// lapse moves the durable lease 31 s into the past: the command that held it
// died and has not renewed for longer than the 30 s lease.
func (f *quiesceInstall) lapse(t *testing.T) {
	t.Helper()
	row := f.freezeRow(t)
	require.NotNil(t, row)
	row.LeaseUntil = time.Now().Add(-31 * time.Second)
	raw, err := json.Marshal(row)
	require.NoError(t, err)
	_, err = f.pool.Exec(t.Context(), `UPDATE install_settings SET value=$1 WHERE key='quiesce'`, raw)
	require.NoError(t, err)
}

func requireQuiesced(t *testing.T, err error) *InstallQuiescedError {
	t.Helper()
	var quiesced *InstallQuiescedError
	require.ErrorAs(t, err, &quiesced)
	require.EqualError(t, err, "install quiesced")
	return quiesced
}

// One freeze: admissions drain, every awake machine is captured and stopped,
// the runtime stops, and only then is the freeze ready. Between the freeze
// and the reopen every mutation class is refused with a retry time, reads
// succeed, and a restarted backend still enforces it.
func TestInstallQuiesceFreezesOneConsistentSnapshot(t *testing.T) {
	f := newQuiesceInstall(t)
	ctx := t.Context()
	first := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	second := f.machine(t, f.owner, "smithers/todo-b", "running", "vm-b", strings.Repeat("c", 40))
	asleep := f.machine(t, f.owner, "smithers/todo-c", "suspended", "vm-c", strings.Repeat("d", 40))
	for _, class := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		require.NoError(t, f.quiesce.Gate.Admit(ctx, class), class)
	}

	freeze, err := f.quiesce.Freeze(ctx, "backup-1", 7)
	require.NoError(t, err)
	require.True(t, freeze.Ready)
	require.Equal(t, "backup-1", freeze.Op)
	require.Equal(t, []string{"drain", "T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01", "stop"}, *f.calls)
	require.ElementsMatch(t, []string{"capture " + first, "stop " + first, "capture " + second, "stop " + second}, f.peer.events)
	for _, id := range []string{first, second, asleep} {
		require.Equal(t, "suspended", f.status(t, id))
	}
	durable := f.freezeRow(t)
	require.NotNil(t, durable)
	require.Equal(t, "backup-1", durable.Op)
	require.Equal(t, int64(7), durable.By)
	require.True(t, durable.Ready)

	for _, class := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		quiesced := requireQuiesced(t, f.quiesce.Gate.Admit(ctx, class))
		require.WithinDuration(t, durable.LeaseUntil, quiesced.RetryAt, time.Millisecond, class)
		require.True(t, quiesced.RetryAt.After(time.Now()), class)
	}
	for _, class := range []string{"GET", "HEAD", "OPTIONS"} {
		require.NoError(t, f.quiesce.Gate.Admit(ctx, class), class)
	}
	// A backend that restarts during the freeze reads it from the database.
	restarted := f.compose()
	requireQuiesced(t, restarted.Gate.Admit(ctx, "POST"))
	require.NoError(t, restarted.RequireReady(ctx, "backup-1", 7))
	require.EqualError(t, restarted.RequireReady(ctx, "backup-2", 7), "ready owner quiesce lease required")

	// The holder renews; nobody else can take or clear the freeze.
	renewed, err := f.quiesce.Renew(ctx, "backup-1", 7)
	require.NoError(t, err)
	require.False(t, renewed.LeaseUntil.Before(freeze.LeaseUntil))
	_, err = f.quiesce.Freeze(ctx, "backup-2", 7)
	requireQuiesced(t, err)
	_, err = f.quiesce.Freeze(ctx, "backup-1", 8)
	requireQuiesced(t, err)
	requireQuiesced(t, f.quiesce.Reopen(ctx, "backup-2"))
	require.Len(t, f.peer.events, 4, "a renewal captures nothing again")

	*f.calls = nil
	require.NoError(t, f.quiesce.Reopen(ctx, "backup-1"))
	require.Nil(t, f.freezeRow(t))
	require.Equal(t, []string{"resume", "resume-T-SEC-01", "resume-T-TRM-07", "resume-T-GH-09", "resume-T-COL-09", "resume-T-COL-08", "resume-T-STK-04", "resume"}, *f.calls)
	for _, class := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		require.NoError(t, f.quiesce.Gate.Admit(ctx, class), class)
	}
	// Machines stay asleep after the reopen and wake on demand.
	require.Equal(t, "suspended", f.status(t, first))
}

// A backup command killed after the freeze stops renewing. Once its 30 s
// lease has lapsed the next mutation reopens the install, in this process or
// a restarted one: admissions never stay closed after a crashed backup.
func TestInstallQuiesceReopensAfterAKilledCommand(t *testing.T) {
	for _, restart := range []bool{false, true} {
		name := "same backend"
		if restart {
			name = "restarted backend"
		}
		t.Run(name, func(t *testing.T) {
			f := newQuiesceInstall(t)
			ctx := t.Context()
			id := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
			_, err := f.quiesce.Freeze(ctx, "backup-killed", 7)
			require.NoError(t, err)
			requireQuiesced(t, f.quiesce.Gate.Admit(ctx, "POST"))

			f.lapse(t)
			*f.calls = nil
			service := f.quiesce
			if restart {
				service = f.compose()
			}
			require.NoError(t, service.Gate.Admit(ctx, "POST"))
			require.Nil(t, f.freezeRow(t))
			require.Equal(t, []string{"resume", "resume-T-SEC-01", "resume-T-TRM-07", "resume-T-GH-09", "resume-T-COL-09", "resume-T-COL-08", "resume-T-STK-04", "resume"}, *f.calls)
			// The killed command's op can no longer export or renew anything.
			require.EqualError(t, service.RequireReady(ctx, "backup-killed", 7), "ready owner quiesce lease required")
			_, err = service.Renew(ctx, "backup-killed", 7)
			require.EqualError(t, err, "quiesce lease lost")
			require.Equal(t, "suspended", f.status(t, id), "the captured machine stays asleep with its disk")
		})
	}
}

// While .upgrade-incomplete exists a lapsed lease never reopens the install:
// the data may be half migrated, and only a restore or a finished upgrade
// clears the marker.
func TestInstallQuiesceMarkerOutlivesTheLease(t *testing.T) {
	f := newQuiesceInstall(t)
	ctx := t.Context()
	_, err := f.quiesce.Freeze(ctx, "upgrade-1", 7)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(f.state, ".upgrade-incomplete"), []byte("backups/1.2.3-20261007T010203.000000000Z\n"), 0600))
	f.lapse(t)
	*f.calls = nil

	requireQuiesced(t, f.quiesce.Gate.Admit(ctx, "POST"))
	requireQuiesced(t, f.compose().Gate.Admit(ctx, "POST"))
	require.NoError(t, f.quiesce.Gate.Admit(ctx, "GET"))
	requireQuiesced(t, f.quiesce.Reopen(ctx, "upgrade-1"))
	require.NotNil(t, f.freezeRow(t))
	require.Empty(t, *f.calls, "nothing resumes while the marker exists")

	// Even with the freeze row gone, the marker alone keeps the install closed.
	_, err = f.pool.Exec(ctx, `DELETE FROM install_settings WHERE key='quiesce'`)
	require.NoError(t, err)
	requireQuiesced(t, f.compose().Gate.Admit(ctx, "POST"))

	require.NoError(t, os.Remove(filepath.Join(f.state, ".upgrade-incomplete")))
	require.NoError(t, f.quiesce.Gate.Admit(ctx, "POST"))
}

// A machine whose capture fails ends the freeze: the error names its branch,
// admissions reopen, and no freeze row survives. The command exits non-zero
// with nothing published.
func TestInstallQuiesceCaptureFailureReopens(t *testing.T) {
	f := newQuiesceInstall(t)
	ctx := t.Context()
	first := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
	second := f.machine(t, f.owner, "smithers/todo-b", "running", "vm-b", strings.Repeat("c", 40))
	f.peer.captureErr[second] = errors.New("outbox undrained")

	freeze, err := f.quiesce.Freeze(ctx, "backup-1", 7)
	require.Nil(t, freeze)
	require.ErrorContains(t, err, "branch smithers/todo-b: ")
	require.Nil(t, f.freezeRow(t))
	require.NoError(t, f.quiesce.Gate.Admit(ctx, "POST"))
	require.Equal(t, "suspended", f.status(t, first))
	require.Equal(t, "running", f.status(t, second))
	require.NotContains(t, *f.calls, "stop", "the runtime keeps running when capture fails")
	require.Contains(t, *f.calls, "resume")
}

// A machine provider without capture or its runtime refuses before the
// freeze: no drain runs, no row is written and admissions never close.
func TestInstallQuiesceRefusesBeforeFreezingWithoutCapture(t *testing.T) {
	for name, remove := range map[string]WorkspaceServiceOption{
		"capture": func(s *WorkspaceService) { s.branchCapture = nil },
		"runtime": func(s *WorkspaceService) { s.runtime = nil },
		"store":   func(s *WorkspaceService) { s.branchHeads = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := newQuiesceInstall(t)
			ctx := t.Context()
			id := f.machine(t, f.owner, "smithers/todo-a", "running", "vm-a", strings.Repeat("a", 40))
			remove(f.service)

			require.EqualError(t, f.quiesce.Available(), "quiesce unavailable: T-MCH-07 required")
			require.EqualError(t, f.quiesce.Check(ctx), "quiesce unavailable: T-MCH-07 required")
			_, err := f.quiesce.Freeze(ctx, "backup-1", 7)
			require.EqualError(t, err, "quiesce unavailable: T-MCH-07 required")
			require.Empty(t, *f.calls)
			require.Nil(t, f.freezeRow(t))
			require.NoError(t, f.quiesce.Gate.Admit(ctx, "POST"))
			require.Equal(t, "running", f.status(t, id))
			require.Empty(t, f.peer.events)
		})
	}
}
