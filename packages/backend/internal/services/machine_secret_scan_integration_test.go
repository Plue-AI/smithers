package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	"github.com/stretchr/testify/require"
)

// The trusted reference-host journey harness supplies IDs and random fixture
// sentinels after production TODO/manual dispatch. This test attaches read-only;
// it never creates a second install runtime or executes a repository scan script.
// Captures must be complete materialized trees, not files selected by a guest.
func TestMachineSecretScanRealMicroVM(t *testing.T) {
	if os.Getenv("SMITHERS_CSEC01_CHECK") != "1" {
		t.Skip("C-SEC-01 waits for the reference Mac mini")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	var fixture struct {
		Commit      string
		DatabaseURL string
		Bundle      string
		Evidence    string
		Sentinels   map[string]string
		Machines    []struct {
			Kind, Workspace, Machine              string
			RunID                                 int64
			CaptureTree, OperationLog, RelayAudit string
			ModelCredentialKind                   string
		}
	}
	body, err := os.ReadFile(os.Getenv("SMITHERS_CSEC01_FIXTURE"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(body, &fixture))
	require.Regexp(t, `^[0-9a-f]{40}$`, fixture.Commit)
	require.NotEmpty(t, fixture.Evidence)
	// Required fixture labels and expectations are literal, never the predicate.
	require.Len(t, fixture.Sentinels, 5)
	for _, label := range []string{"ALL", "MAIN", "BOUND", "PROVIDER", "PEM"} {
		require.Len(t, fixture.Sentinels[label], 40)
	}
	unique := map[string]bool{}
	for _, value := range fixture.Sentinels {
		require.False(t, unique[value])
		unique[value] = true
	}
	installed, err := installbundle.Open(fixture.Bundle)
	require.NoError(t, err)
	require.Equal(t, fixture.Commit, installed.Revision())
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, fixture.DatabaseURL)
	require.NoError(t, err)
	defer pool.Close()
	require.NoError(t, pool.Ping(ctx))
	require.Len(t, fixture.Machines, 3)
	kinds := map[string]bool{}
	require.NoError(t, os.MkdirAll(fixture.Evidence, 0700))
	for _, machine := range fixture.Machines {
		t.Run(machine.Kind, func(t *testing.T) {
			require.Contains(t, []string{"item", "scratch", "main"}, machine.Kind)
			require.False(t, kinds[machine.Kind])
			kinds[machine.Kind] = true
			var persisted, machineIdentity string
			require.NoError(t, pool.QueryRow(ctx, `SELECT id::text,vm_id FROM workspaces WHERE id=$1 AND status='running' AND deleted_at IS NULL`, machine.Workspace).Scan(&persisted, &machineIdentity))
			require.Equal(t, machine.Workspace, persisted)
			require.Equal(t, machine.Machine, machineIdentity)
			if machine.Kind == "main" {
				trusted, err := TrustedMainMachine(ctx, pool, db.New(pool), machine.Workspace)
				require.NoError(t, err)
				require.True(t, trusted)
			} else if machine.Kind == "item" {
				var n int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mythical_items WHERE workspace_id=$1`, machine.Workspace).Scan(&n))
				require.Positive(t, n)
			}
			scan, err := microsandbox.ScanInstalledMachine(ctx, microsandbox.Config{Bundle: installed}, machine.Machine, fixture.Sentinels)
			require.NoError(t, err)
			hits := map[string][]string{}
			for _, hit := range scan.Hits {
				require.Contains(t, fixture.Sentinels, hit.Label)
				require.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(fixture.Sentinels[hit.Label]))), hit.SHA256)
				hits[hit.Label] = append(hits[hit.Label], hit.Path)
			}
			require.Empty(t, hits["PROVIDER"])
			require.Empty(t, hits["PEM"])
			require.Empty(t, hits["BOUND"])
			require.Contains(t, hits["ALL"], "/run/smithers/env")
			session := false
			for _, path := range hits["ALL"] {
				session = session || strings.HasPrefix(path, "/proc/") && strings.HasSuffix(path, "/environ")
			}
			require.True(t, session, "positive control must reach a session")
			if machine.Kind == "main" {
				require.Contains(t, hits["MAIN"], "/run/smithers/env")
			} else {
				require.Empty(t, hits["MAIN"])
			}
			encoded, err := json.MarshalIndent(scan, "", "  ")
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(fixture.Evidence, machine.Kind+"-scan.json"), encoded, 0600))
			if machine.Kind != "main" {
				require.NotEmpty(t, machine.CaptureTree)
				require.NotEmpty(t, machine.OperationLog)
				require.NoError(t, filepath.WalkDir(machine.CaptureTree, func(path string, entry fs.DirEntry, walkErr error) error {
					if walkErr != nil {
						return walkErr
					}
					if entry.IsDir() {
						return nil
					}
					require.True(t, entry.Type().IsRegular(), "capture must contain only ordinary files: %s", path)
					return assertNoFixtureSentinels(t, path, fixture.Sentinels)
				}))
				require.NoError(t, assertNoFixtureSentinels(t, machine.OperationLog, fixture.Sentinels))
			}
			audit, err := os.ReadFile(machine.RelayAudit)
			require.NoError(t, err)
			for _, label := range []string{"PROVIDER", "PEM", "MAIN"} {
				require.NotContains(t, string(audit), fixture.Sentinels[label])
			}
			if machine.Kind == "item" {
				require.Equal(t, "run", machine.ModelCredentialKind)
				require.Positive(t, machine.RunID)
				var calls int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM model_usage WHERE workflow_run_id=$1`, machine.RunID).Scan(&calls))
				require.Positive(t, calls)
			}
		})
	}
	require.Len(t, kinds, 3)
}

func assertNoFixtureSentinels(t *testing.T, path string, sentinels map[string]string) error {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	var tail string
	buffer := make([]byte, 1<<20)
	for {
		n, err := file.Read(buffer)
		data := tail + string(buffer[:n])
		for label, value := range sentinels {
			require.NotContains(t, data, value, "%s in %s", label, path)
		}
		if len(data) > 255 {
			tail = data[len(data)-255:]
		} else {
			tail = data
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
