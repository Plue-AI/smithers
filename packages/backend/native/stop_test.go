package native

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The real-GitHub walk's owned PostgreSQL outlived a graceful stop: the app's
// teardown ran past the launcher's grace, the launcher killed the backend,
// and the database stop never ran.
func TestStopAfterAppStopsTheDatabaseWhenTheAppReturns(t *testing.T) {
	appDone := make(chan error, 1)
	appDone <- errors.New("app failed")
	var stops int
	appErr, stopErr := stopAfterApp(appDone, func() error { stops++; return nil }, time.Hour)
	require.EqualError(t, appErr, "app failed")
	require.NoError(t, stopErr)
	require.Equal(t, 1, stops)
}

func TestStopAfterAppStopsTheDatabaseAtGraceWhileTheAppTearsDown(t *testing.T) {
	appDone := make(chan error)
	stopped := make(chan struct{})
	// The app finishes only after the database has stopped: a teardown
	// slower than the grace still leaves no PostgreSQL behind.
	go func() {
		<-stopped
		appDone <- nil
	}()
	started := time.Now()
	appErr, stopErr := stopAfterApp(appDone, func() error {
		close(stopped)
		return errors.New("postgres required immediate shutdown")
	}, 20*time.Millisecond)
	require.NoError(t, appErr, "the app's own result is still returned")
	require.EqualError(t, stopErr, "postgres required immediate shutdown")
	require.GreaterOrEqual(t, time.Since(started), 20*time.Millisecond)
}
