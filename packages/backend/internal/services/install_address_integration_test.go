package services

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// recordedListener is a listener seam that records each bind it is asked to
// serve and refuses the one named in refuse.
type recordedListener struct {
	mu     sync.Mutex
	binds  []string
	refuse string
}

func (l *recordedListener) Listen(bind string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if bind != "" && bind == l.refuse {
		return errors.New("address already in use")
	}
	l.binds = append(l.binds, bind)
	return nil
}

func (l *recordedListener) served() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.binds...)
}

// M-28 / J1 2.1: the Address step governs the listener and the known
// origins, without a restart, and both survive one.
func TestInstallAddressStepServesItsBindAndOriginsPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	store, err := jobs.NewStore(pool)
	require.NoError(t, err)
	ctx := t.Context()
	q := db.New(pool)
	configured := []string{"http://127.0.0.1:4000"}
	listener := &recordedListener{refuse: "10.9.9.9:4000"}
	address := &InstallAddress{Configured: configured, Listen: listener.Listen}
	require.NoError(t, address.Load(ctx, q))
	address.Serve()
	require.Empty(t, listener.served(), "a fresh install serves loopback only")
	service := &InstallSetupService{Pool: pool, Jobs: store, Address: address}
	require.NoError(t, service.Initialize(ctx))
	settle := func(key, body string) InstallStep {
		t.Helper()
		_, err := service.Admit(ctx, "address", key, json.RawMessage(body))
		require.NoError(t, err)
		running, err := service.readStep(ctx, q, "address")
		require.NoError(t, err)
		require.Equal(t, InstallRunning, running.Status, "the card shows the step working until the listener is done")
		workerCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- store.RunWorker(workerCtx, jobs.WorkerConfig{WorkerID: "address-" + key, Capacity: 1, Lease: time.Second, PollInterval: time.Millisecond, Operations: []string{"install.setup.address"}}, service.Handle)
		}()
		var step InstallStep
		require.Eventually(t, func() bool {
			step, err = service.readStep(ctx, q, "address")
			return err == nil && step.Status != InstallRunning
		}, 5*time.Second, 10*time.Millisecond)
		cancel()
		require.NoError(t, <-done)
		return step
	}

	// A bind the Mac cannot listen on fails the step and changes nothing.
	failed := settle("refused", `{"bind":"10.9.9.9:4000","origins":["http://mini.local:4000"]}`)
	require.Equal(t, InstallFailed, failed.Status)
	require.Equal(t, &InstallReadinessError{Code: "address_unavailable", Class: "user", Message: "Can't listen on 10.9.9.9:4000"}, failed.Error)
	_, err = q.GetInstallSetting(ctx, "bind")
	require.ErrorIs(t, err, pgx.ErrNoRows)
	require.Equal(t, configured, address.Origins())
	require.Empty(t, listener.served())

	// Network: the new listener serves before the step is done, and the
	// teammates' origin is known on the next request.
	done := settle("network", `{"bind":"0.0.0.0:4000","origins":["http://mini.local:4000"]}`)
	require.Equal(t, InstallReady, done.Status)
	require.Nil(t, done.Error)
	require.Equal(t, []string{"0.0.0.0:4000"}, listener.served())
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://mini.local:4000"}, address.Origins())
	status, err := service.Status(ctx)
	require.NoError(t, err)
	encoded, err := json.Marshal(status["address"])
	require.NoError(t, err)
	require.JSONEq(t, `{"listen":"network","bind":"0.0.0.0:4000","origins":["http://mini.local:4000"]}`, string(encoded))

	// A restarted backend loads the saved Address and serves its bind.
	restarted := &recordedListener{}
	again := &InstallAddress{Configured: configured, Listen: restarted.Listen}
	require.NoError(t, again.Load(ctx, q))
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://mini.local:4000"}, again.Origins())
	again.Serve()
	require.Equal(t, []string{"0.0.0.0:4000"}, restarted.served())

	// A saved bind that no longer listens leaves loopback serving at startup.
	lost := &InstallAddress{Configured: configured, Listen: (&recordedListener{refuse: "0.0.0.0:4000"}).Listen}
	require.NoError(t, lost.Load(ctx, q))
	lost.Serve()
	require.Equal(t, []string{"http://127.0.0.1:4000", "http://mini.local:4000"}, lost.Origins())
}
