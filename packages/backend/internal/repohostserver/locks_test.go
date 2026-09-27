package repohostserver

import (
	"context"
	"net/http"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// lockT takes a lock that must be granted.
func lockT(t *testing.T, lock func(context.Context, string) (func(), error), key string) func() {
	t.Helper()
	unlock, err := lock(context.Background(), key)
	require.NoError(t, err)
	return unlock
}

// acquireAsync takes a lock in a goroutine; the channel closes once it is
// granted (and released again).
func acquireAsync(lock func(context.Context, string) (func(), error), key string) <-chan struct{} {
	acquired := make(chan struct{})
	go func() {
		if unlock, err := lock(context.Background(), key); err == nil {
			close(acquired)
			unlock()
		}
	}()
	return acquired
}

func requireWaits(t *testing.T, acquired <-chan struct{}) {
	t.Helper()
	select {
	case <-acquired:
		t.Fatal("lock granted while it should wait")
	case <-time.After(25 * time.Millisecond):
	}
}

func requireGranted(t *testing.T, acquired <-chan struct{}) {
	t.Helper()
	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("lock not granted")
	}
}

func TestRepoLockerSerializesSameKey(t *testing.T) {
	locker := newRepoLocker()
	unlock1 := lockT(t, locker.Lock, "repo")
	acquired := acquireAsync(locker.Lock, "repo")
	requireWaits(t, acquired)
	unlock1()
	requireGranted(t, acquired)
}

func TestRepoLockerAllowsConcurrentReaders(t *testing.T) {
	locker := newRepoLocker()
	defer lockT(t, locker.RLock, "repo")()
	requireGranted(t, acquireAsync(locker.RLock, "repo"))
}

func TestRepoLockerWriterWaitsForReaders(t *testing.T) {
	locker := newRepoLocker()
	unlockRead := lockT(t, locker.RLock, "repo")
	acquired := acquireAsync(locker.Lock, "repo")
	requireWaits(t, acquired)
	unlockRead()
	requireGranted(t, acquired)
}

func TestRepoLockerRemovesEntryAfterFinalUnlock(t *testing.T) {
	locker := newRepoLocker()
	lockT(t, locker.Lock, "repo")()
	require.Empty(t, locker.locks)
}

func TestRepoLockerLockAllSerializesSameKeysInAnyOrder(t *testing.T) {
	locker := newRepoLocker()
	unlock1, err := locker.LockAll(context.Background(), "repo-b", "repo-a")
	require.NoError(t, err)
	acquired := make(chan struct{})
	go func() {
		if unlock2, err := locker.LockAll(context.Background(), "repo-a", "repo-b"); err == nil {
			close(acquired)
			unlock2()
		}
	}()
	requireWaits(t, acquired)
	unlock1()
	requireGranted(t, acquired)
}

// A write to a held key fails at once with 503 and a Retry-After; LockAll
// fails, taking no lock, when any of its keys is held. Reads proceed, and
// once the hold is released writes go through.
func TestRepoLockerFailsWritesToHeldKeysAtOnce(t *testing.T) {
	locker := newRepoLocker()
	release := locker.Hold("b")
	for _, lock := range []func() (func(), error){
		func() (func(), error) { return locker.Lock(context.Background(), "b") },
		func() (func(), error) { return locker.LockAll(context.Background(), "a", "b") },
	} {
		_, err := lock()
		var appErr *appError
		require.ErrorAs(t, err, &appErr)
		require.Equal(t, http.StatusServiceUnavailable, appErr.StatusCode)
		require.Equal(t, repositoryHeldCode, appErr.Code)
		require.Positive(t, appErr.RetryAfter)
	}
	require.Empty(t, locker.locks, "a failed LockAll kept a lock")
	lockT(t, locker.RLock, "b")()
	lockT(t, locker.Lock, "a")()
	release()
	unlock, err := locker.LockAll(context.Background(), "a", "b")
	require.NoError(t, err)
	unlock()
}

// A waiter whose context ends stops waiting: its goroutine returns and it
// leaves no reference on the lock.
func TestRepoLockerWaitFollowsContext(t *testing.T) {
	locker := newRepoLocker()
	unlock := lockT(t, locker.Lock, "repo")
	const waiters = 50
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	for range waiters {
		go func() {
			_, err := locker.Lock(ctx, "repo")
			done <- err
		}()
	}
	require.Eventually(t, func() bool {
		locker.mu.Lock()
		defer locker.mu.Unlock()
		return locker.locks["repo"].refs == waiters+1
	}, time.Second, time.Millisecond)
	require.GreaterOrEqual(t, runtime.NumGoroutine(), before+waiters)
	cancel()
	for range waiters {
		select {
		case err := <-done:
			require.Error(t, err)
		case <-time.After(time.Second):
			t.Fatal("a cancelled waiter kept waiting")
		}
	}
	locker.mu.Lock()
	require.Equal(t, 1, locker.locks["repo"].refs)
	locker.mu.Unlock()
	require.Eventually(t, func() bool { return runtime.NumGoroutine() < before+waiters/2 }, time.Second, 10*time.Millisecond)
	unlock()
	require.Empty(t, locker.locks)
}
