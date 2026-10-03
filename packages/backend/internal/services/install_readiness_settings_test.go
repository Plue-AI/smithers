package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"sync"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// T-INS-06 Changes; spec §8.6.3, §16.2: these are literal persisted setup ids
// and states, not values inferred from the readiness implementation.
func TestInstallReadinessSettingsCommitsPairAndRestarts(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	_, err := pool.Exec(t.Context(), `INSERT INTO install_settings(key,value) VALUES
 ('setup.step.source','{"status":"pending","operation_id":"source-op","attempt":2}'),
 ('setup.step.machine','{"status":"running","operation_id":"machine-op","attempt":3,"expires_at":"2026-10-03T12:00:00Z"}')`)
	require.NoError(t, err)
	want := InstallReadiness{Source: InstallReadinessStep{State: InstallReady, Pct: 100}, Machine: InstallReadinessStep{State: InstallRunning, Pct: 43}, Revision: "0123456789abcdef0123456789abcdef01234567", Attempt: 4}
	got, err := store.Update(t.Context(), "owner/repo", func(InstallReadiness) (InstallReadiness, error) { return want, nil })
	require.NoError(t, err)
	require.Equal(t, want, got)
	var source, machine map[string]any
	for key, dst := range map[string]*map[string]any{"source": &source, "machine": &machine} {
		var raw []byte
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT value FROM install_settings WHERE key=$1`, "setup.step."+key).Scan(&raw))
		require.NoError(t, json.Unmarshal(raw, dst))
	}
	require.Equal(t, "done", source["status"])
	require.Equal(t, "running", machine["status"])
	require.Equal(t, float64(100), source["pct"])
	require.Equal(t, float64(43), machine["pct"])
	require.Equal(t, "source-op", source["operation_id"])
	require.Equal(t, "machine-op", machine["operation_id"])
	require.Equal(t, float64(3), machine["attempt"])
	require.Equal(t, "2026-10-03T12:00:00Z", machine["expires_at"])
	restarted := &InstallReadinessSettings{Pool: pool}
	got, err = restarted.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) {
		require.Equal(t, want, current)
		return current, nil
	})
	require.NoError(t, err)
	require.Equal(t, want, got)
	_, err = restarted.Update(t.Context(), "other/repo", func(current InstallReadiness) (InstallReadiness, error) {
		t.Fatal("foreign repository mutates readiness")
		return current, nil
	})
	require.Error(t, err)
}

func TestInstallReadinessSettingsRollbackAndErrorRoundTrip(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	failure := &InstallReadinessError{Code: "recipe_invalid", Class: "user", Message: "change machine.json", Fix: "https://example.com/fix"}
	want := InstallReadiness{Source: InstallReadinessStep{State: InstallReady, Pct: 100}, Machine: InstallReadinessStep{State: InstallFailed, Error: failure}, Attempt: 7}
	_, err := store.Update(t.Context(), "owner/repo", func(InstallReadiness) (InstallReadiness, error) { return want, nil })
	require.NoError(t, err)
	sentinel := errors.New("abort")
	got, err := store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) {
		require.Equal(t, want, current)
		return InstallReadiness{}, sentinel
	})
	require.ErrorIs(t, err, sentinel)
	require.Equal(t, want, got)
	// A deferred trigger fails the commit after both writes; neither may escape.
	_, err = pool.Exec(t.Context(), `CREATE FUNCTION readiness_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'readiness commit rejected'; END $$;
 CREATE CONSTRAINT TRIGGER readiness_abort AFTER UPDATE ON install_settings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION readiness_abort()`)
	require.NoError(t, err)
	_, err = store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) {
		current.Attempt++
		current.Machine = InstallReadinessStep{State: InstallReady, Pct: 100}
		return current, nil
	})
	require.ErrorContains(t, err, "readiness commit rejected")
	_, err = pool.Exec(t.Context(), `DROP TRIGGER readiness_abort ON install_settings`)
	require.NoError(t, err)
	got, err = store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) { return current, nil })
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestInstallReadinessSettingsSerializesConcurrentAttempts(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	const workers = 8
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.Update(context.Background(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) { current.Attempt++; return current, nil })
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	got, err := store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) { return current, nil })
	require.NoError(t, err)
	require.Equal(t, uint64(workers), got.Attempt)
}

func TestInstallReadinessSettingsInvalidWritesLeaveNoPartialPair(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	for _, tc := range []struct {
		name    string
		machine InstallReadinessStep
	}{
		{"unknown state", InstallReadinessStep{State: "complete"}},
		{"negative progress", InstallReadinessStep{State: InstallRunning, Pct: -1}},
		{"excess progress", InstallReadinessStep{State: InstallRunning, Pct: 101}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.Update(t.Context(), "owner/repo", func(InstallReadiness) (InstallReadiness, error) {
				return InstallReadiness{Source: InstallReadinessStep{State: InstallReady, Pct: 100}, Machine: tc.machine}, nil
			})
			require.Error(t, err)
			var count int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key IN ('setup.step.source','setup.step.machine')`).Scan(&count))
			require.Zero(t, count)
		})
	}
}

func TestInstallReadinessSettingsSuccessClearsFailure(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	_, err := store.Update(t.Context(), "owner/repo", func(InstallReadiness) (InstallReadiness, error) {
		return InstallReadiness{Source: InstallReadinessStep{State: InstallFailed, Error: &InstallReadinessError{Code: "missing", Class: "infra", Message: "missing main"}}}, nil
	})
	require.NoError(t, err)
	_, err = store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) {
		current.Source = InstallReadinessStep{State: InstallReady, Pct: 100}
		current.Machine = InstallReadinessStep{State: InstallReady, Pct: 100}
		return current, nil
	})
	require.NoError(t, err)
	var count int
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key IN ('setup.step.source','setup.step.machine') AND value ? 'error'`).Scan(&count))
	require.Zero(t, count)
}

func TestReadinessFromSettingRejectsCorruptReceipts(t *testing.T) {
	for _, value := range []installReadinessSetting{{Status: "ready"}, {Status: "done", Pct: -1}, {Status: "running", Pct: 101}} {
		_, err := readinessFromSetting(value)
		require.Error(t, err)
	}
	for _, state := range []string{"pending", "running", "done", "failed"} {
		step, err := readinessFromSetting(installReadinessSetting{Status: state})
		require.NoError(t, err)
		if state == "done" {
			require.Equal(t, InstallReady, step.State)
		} else {
			require.Equal(t, state, string(step.State))
		}
	}
	var store *InstallReadinessSettings
	_, err := store.Update(t.Context(), "owner/repo", func(current InstallReadiness) (InstallReadiness, error) { return current, nil })
	require.Error(t, err)
}

// Controlled source/layer providers are necessary here to hold an old attempt
// across takeover without a production fault hook. The production persistence
// and Prepare path run unchanged against real PostgreSQL. Guest preparation
// security is a separate required reference-host check; this test enables none.
func TestInstallReadinessSettingsPrepareFencesOldCompletion(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store := &InstallReadinessSettings{Pool: pool}
	started, release := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	old := InstallMachineReadyService{Persistence: store, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) {
		return "0123456789abcdef0123456789abcdef01234567", nil
	}}, Layers: readinessLayers(func(ctx context.Context, _ workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		close(started)
		select {
		case <-release:
			return microsandbox.Layer{Key: "old-layer"}, nil
		case <-ctx.Done():
			return microsandbox.Layer{}, ctx.Err()
		}
	})}
	done := make(chan error, 1)
	go func() { _, err := old.Prepare(ctx, "owner/repo"); done <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var source, machine string
	require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT value->>'status' FROM install_settings WHERE key='setup.step.source'),(SELECT value->>'status' FROM install_settings WHERE key='setup.step.machine')`).Scan(&source, &machine))
	require.Equal(t, "done", source)
	require.Equal(t, "running", machine)
	newer := InstallMachineReadyService{Persistence: &InstallReadinessSettings{Pool: pool}, Sources: readinessSources{resolve: func(context.Context, string, string) (string, error) {
		return "fedcba9876543210fedcba9876543210fedcba98", nil
	}}, Layers: readinessLayers(func(context.Context, workspaceapi.WorkspaceSpec) (microsandbox.Layer, error) {
		return microsandbox.Layer{Key: "new-layer"}, nil
	})}
	want, err := newer.Prepare(ctx, "owner/repo")
	require.NoError(t, err)
	close(release)
	select {
	case err = <-done:
		require.ErrorIs(t, err, ErrInstallReadinessSuperseded)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	got, err := store.Update(ctx, "owner/repo", func(current InstallReadiness) (InstallReadiness, error) { return current, nil })
	require.NoError(t, err)
	require.Equal(t, want, got)
	require.Equal(t, "fedcba9876543210fedcba9876543210fedcba98", got.Revision)
	require.Equal(t, "new-layer", got.LayerKey)
	require.Equal(t, uint64(2), got.Attempt)
}
