package compose

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// PostgreSQL and its tools are real. Only the unlanded capture/drain contracts
// are fixtures: these exports do not qualify a successful installed backup.
func TestInstallMaintenanceDatabaseSocket(t *testing.T) {
	bin := os.Getenv("SMITHERS_INS07_POSTGRES_BIN")
	if bin == "" {
		t.Skip("set SMITHERS_INS07_POSTGRES_BIN to PostgreSQL 18 tools")
	}
	state := t.TempDir()
	require.NoError(t, os.Chmod(state, 0700))
	database, err := postgres.Start(t.Context(), postgres.Config{BinDir: bin, StateDir: filepath.Join(state, "postgres"), Major: 18})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, database.Stop(context.Background())) })
	pool, err := postgresfixture.Open(t.Context(), database.ConnectionString, 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	q := db.New(pool)
	owner, err := q.CreateUser(t.Context(), db.CreateUserParams{Username: "dumpowner", LowerUsername: "dumpowner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1);`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `CREATE TABLE maintenance_fixture(value text); INSERT INTO maintenance_fixture VALUES('snapshot-row-before-mutation')`)
	require.NoError(t, err)
	calls := []string{}
	steps := installMaintenancePreflightFixture{calls: &calls}
	service := services.NewInstallQuiesce(&services.QuiesceGate{Store: services.InstallQuiesceStore{Pool: pool}, StateDir: state})
	service.Machines, service.Admission, service.Host = steps, steps, steps
	service.Barriers = map[string]services.QuiesceBarrier{}
	for _, ticket := range []string{"T-STK-04", "T-COL-08", "T-COL-09", "T-GH-09", "T-TRM-07", "T-SEC-01"} {
		service.Barriers[ticket] = steps
	}
	closeSocket, err := startInstallMaintenanceHandoff(t.Context(), state, pool, func(context.Context, io.Writer) error { return nil }, database, service)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, closeSocket()) })
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(state, "run/host.sock"))
	}}}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://install/maintenance/database/size")
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	var size struct {
		Bytes uint64 `json:"bytes"`
	}
	require.NoError(t, json.NewDecoder(response.Body).Decode(&size))
	require.NoError(t, response.Body.Close())
	require.Greater(t, size.Bytes, uint64(0))
	var expected uint64
	require.NoError(t, pool.QueryRow(t.Context(), `SELECT pg_database_size(current_database())`).Scan(&expected))
	require.Equal(t, expected, size.Bytes)
	for _, tc := range []struct {
		name string
		row  *services.QuiesceFreeze
		op   string
	}{
		{"missing freeze", nil, "backup-export"},
		{"missing op", &services.QuiesceFreeze{Op: "backup-export", By: owner.ID, Ready: true, LeaseUntil: time.Now().Add(time.Minute)}, ""},
		{"other operation", &services.QuiesceFreeze{Op: "other", By: owner.ID, Ready: true, LeaseUntil: time.Now().Add(time.Minute)}, "backup-export"},
		{"other owner", &services.QuiesceFreeze{Op: "backup-export", By: owner.ID + 1, Ready: true, LeaseUntil: time.Now().Add(time.Minute)}, "backup-export"},
		{"draining", &services.QuiesceFreeze{Op: "backup-export", By: owner.ID, LeaseUntil: time.Now().Add(time.Minute)}, "backup-export"},
		{"expired", &services.QuiesceFreeze{Op: "backup-export", By: owner.ID, Ready: true, LeaseUntil: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}, "backup-export"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, service.Gate.Store.Update(t.Context(), func(*services.QuiesceFreeze) (*services.QuiesceFreeze, error) { return tc.row, nil }))
			response, err := client.Post("http://install/maintenance/database/dump?op="+tc.op, "application/json", nil)
			require.NoError(t, err)
			require.Equal(t, 503, response.StatusCode)
			body, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			require.NotContains(t, string(body), "PGDMP")
			var row string
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT value FROM maintenance_fixture`).Scan(&row))
			require.Equal(t, "snapshot-row-before-mutation", row)
			require.Empty(t, calls)
		})
	}
	ready := &services.QuiesceFreeze{Op: "backup-export", By: owner.ID, Ready: true, LeaseUntil: time.Now().Add(10 * time.Minute)}
	require.NoError(t, service.Gate.Store.Update(t.Context(), func(*services.QuiesceFreeze) (*services.QuiesceFreeze, error) { return ready, nil }))
	response, err = client.Post("http://install/maintenance/database/dump?op=backup-export", "application/json", nil)
	require.NoError(t, err)
	require.Equal(t, 200, response.StatusCode)
	require.Equal(t, "application/octet-stream", response.Header.Get("Content-Type"))
	dump, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.True(t, strings.HasPrefix(string(dump), "PGDMP"))
	// Independently restore the observed stream with real pg_restore and verify
	// the seeded row, rather than trusting a generated manifest or dump header.
	restored, err := postgres.Start(t.Context(), postgres.Config{BinDir: bin, StateDir: filepath.Join(t.TempDir(), "postgres"), Major: 18})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, restored.Stop(context.Background())) })
	require.NoError(t, restored.RestoreDump(t.Context(), strings.NewReader(string(dump))))
	restoredPool, err := postgresfixture.Open(t.Context(), restored.ConnectionString, 4)
	require.NoError(t, err)
	defer restoredPool.Close()
	var row string
	require.NoError(t, restoredPool.QueryRow(t.Context(), `SELECT value FROM maintenance_fixture`).Scan(&row))
	require.Equal(t, "snapshot-row-before-mutation", row)
	require.Empty(t, calls)
	// Inject one tool failure at the real composed socket boundary. The partial
	// payload is deliberately flushed, so an ordinary EOF would be observable.
	failState := t.TempDir()
	require.NoError(t, os.Chmod(failState, 0700))
	closeFailed, err := startInstallMaintenanceHandoff(t.Context(), failState, pool, func(context.Context, io.Writer) error { return nil }, failedMaintenanceDump{database}, service)
	require.NoError(t, err)
	defer closeFailed()
	failedClient := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(failState, "run/host.sock"))
	}}}
	defer failedClient.CloseIdleConnections()
	failedResponse, err := failedClient.Post("http://install/maintenance/database/dump?op=backup-export", "application/json", nil)
	require.NoError(t, err)
	partial, err := io.ReadAll(failedResponse.Body)
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
	require.Equal(t, "PGDMP-partial", string(partial))
	require.NoError(t, failedResponse.Body.Close())
	lostState := t.TempDir()
	require.NoError(t, os.Chmod(lostState, 0700))
	closeLost, err := startInstallMaintenanceHandoff(t.Context(), lostState, pool, func(context.Context, io.Writer) error { return nil }, expiredMaintenanceDump{database, service.Gate.Store}, service)
	require.NoError(t, err)
	defer closeLost()
	lostClient := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(lostState, "run/host.sock"))
	}}}
	defer lostClient.CloseIdleConnections()
	lostResponse, err := lostClient.Post("http://install/maintenance/database/dump?op=backup-export", "application/json", nil)
	require.NoError(t, err)
	_, err = io.ReadAll(lostResponse.Body)
	require.ErrorIs(t, err, io.ErrUnexpectedEOF, "a dump whose lease expired cannot complete successfully")
	require.NoError(t, lostResponse.Body.Close())
	require.NoError(t, service.Gate.Store.Update(t.Context(), func(*services.QuiesceFreeze) (*services.QuiesceFreeze, error) { return ready, nil }))
	service.Machines = nil
	response, err = client.Post("http://install/maintenance/database/dump?op=backup-export", "application/json", nil)
	require.NoError(t, err)
	require.Equal(t, 503, response.StatusCode)
	refusal, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.Contains(t, string(refusal), "T-MCH-07 required")
	service.Machines = steps
	require.NoError(t, database.Stop(context.Background()))
	response, err = client.Post("http://install/maintenance/database/dump?op=backup-export", "application/json", nil)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 500, response.StatusCode, "a stopped authority cannot return a successful dump")
}

type failedMaintenanceDump struct{ *postgres.Instance }

func (failedMaintenanceDump) Dump(_ context.Context, target io.Writer) error {
	if _, err := io.WriteString(target, "PGDMP-partial"); err != nil {
		return err
	}
	if err := http.NewResponseController(target.(http.ResponseWriter)).Flush(); err != nil {
		return err
	}
	return errors.New("injected pg_dump failure")
}

// This fault occurs after a real dump succeeds, before its final lease check.
type expiredMaintenanceDump struct {
	*postgres.Instance
	store services.QuiesceStore
}

func (p expiredMaintenanceDump) Dump(ctx context.Context, target io.Writer) error {
	if err := p.Instance.Dump(ctx, target); err != nil {
		return err
	}
	if err := http.NewResponseController(target.(http.ResponseWriter)).Flush(); err != nil {
		return err
	}
	return p.store.Update(ctx, func(row *services.QuiesceFreeze) (*services.QuiesceFreeze, error) {
		copy := *row
		copy.LeaseUntil = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
		return &copy, nil
	})
}
