package background

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestJobsRunOncePerKeyAndAnswerAFailureOnce(t *testing.T) {
	jobs := Jobs[string]{FailureTTL: time.Minute}
	release := make(chan error)
	require.True(t, jobs.Start(context.Background(), "box", func(context.Context) error { return <-release }))
	require.False(t, jobs.Start(context.Background(), "box", func(context.Context) error { panic("a second job for one key") }))
	require.True(t, jobs.Running("box"))
	require.NoError(t, jobs.Failed("box"))

	release <- errors.New("host did not start")
	require.Eventually(t, func() bool { return !jobs.Running("box") }, time.Second, time.Millisecond)
	require.EqualError(t, jobs.Failed("box"), "host did not start")
	require.NoError(t, jobs.Failed("box"), "a failure is answered once")

	require.True(t, jobs.Start(context.Background(), "box", func(context.Context) error { return nil }))
	require.Eventually(t, func() bool { return !jobs.Running("box") }, time.Second, time.Millisecond)
	require.NoError(t, jobs.Failed("box"))
	require.True(t, jobs.Start(context.Background(), "box", func(context.Context) error { return nil }), "a success is forgotten")
}

func TestJobsForgetAnExpiredFailure(t *testing.T) {
	jobs := Jobs[string]{FailureTTL: time.Millisecond}
	require.True(t, jobs.Start(context.Background(), "box", func(context.Context) error { return errors.New("failed") }))
	require.Eventually(t, func() bool { return !jobs.Running("box") }, time.Second, time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	require.NoError(t, jobs.Failed("other"))
	require.NoError(t, jobs.Failed("box"))
}

func TestJobsOutliveTheirRequest(t *testing.T) {
	jobs := Jobs[string]{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	jobs.Start(ctx, "box", func(ctx context.Context) error {
		<-time.After(10 * time.Millisecond)
		done <- ctx.Err()
		return nil
	})
	cancel()
	require.NoError(t, <-done)
}
