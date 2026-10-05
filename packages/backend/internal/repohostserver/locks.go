package repohostserver

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/semaphore"
)

// repoLocker is repo-host's per-repository reader/writer lock. Every wait on
// it follows its caller's context, so a request whose client went away stops
// waiting, and a write to a held repository (Hold) fails at once.
type repoLocker struct {
	mu    sync.Mutex
	locks map[string]*repoLockEntry
	// held names the keys whose writes fail (Hold).
	held map[string]struct{}
}

// writerWeight is a writer's share of a lock: all of it. A reader takes one.
const writerWeight = 1 << 40

type repoLockEntry struct {
	sem  *semaphore.Weighted
	refs int
}

func newRepoLocker() *repoLocker {
	return &repoLocker{locks: map[string]*repoLockEntry{}}
}

// Lock takes key's write lock. It fails at once while key is held, and when
// ctx ends first.
func (l *repoLocker) Lock(ctx context.Context, key string) (func(), error) {
	return l.LockAll(ctx, key)
}

// LockAll takes the write locks of keys, in a fixed order. It fails at once,
// taking none, while any of them is held, and when ctx ends first. A hold
// that began while it waited, such as the rollback hold the writer ahead of
// it wrote before releasing the lock, refuses it once it has the locks, and
// it releases them all.
func (l *repoLocker) LockAll(ctx context.Context, keys ...string) (func(), error) {
	ordered := append([]string(nil), keys...)
	sort.Strings(ordered)
	deduped := ordered[:0]
	for _, key := range ordered {
		if len(deduped) == 0 || deduped[len(deduped)-1] != key {
			deduped = append(deduped, key)
		}
	}
	for _, key := range deduped {
		if refusal := l.Refusal(key); refusal != nil {
			return nil, refusal
		}
	}
	unlocks := make([]func(), 0, len(deduped))
	unlockAll := func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}
	for _, key := range deduped {
		unlock, err := l.acquireWeight(ctx, key, writerWeight)
		if err != nil {
			unlockAll()
			return nil, err
		}
		unlocks = append(unlocks, unlock)
	}
	for _, key := range deduped {
		if refusal := l.Refusal(key); refusal != nil {
			unlockAll()
			return nil, refusal
		}
	}
	return unlockAll, nil
}

// RLock takes key's read lock, held or not. It fails when ctx ends first.
func (l *repoLocker) RLock(ctx context.Context, key string) (func(), error) {
	return l.acquireWeight(ctx, key, 1)
}

func (l *repoLocker) acquireWeight(ctx context.Context, key string, weight int64) (func(), error) {
	l.mu.Lock()
	entry := l.locks[key]
	if entry == nil {
		entry = &repoLockEntry{sem: semaphore.NewWeighted(writerWeight)}
		l.locks[key] = entry
	}
	entry.refs++
	l.mu.Unlock()
	if err := entry.sem.Acquire(ctx, weight); err != nil {
		l.release(key, entry)
		return nil, &appError{StatusCode: http.StatusGatewayTimeout, Message: "request ended while waiting for the repository", Cause: err}
	}
	return func() {
		entry.sem.Release(weight)
		l.release(key, entry)
	}, nil
}

func (l *repoLocker) release(key string, entry *repoLockEntry) {
	l.mu.Lock()
	entry.refs--
	if entry.refs == 0 {
		delete(l.locks, key)
	}
	l.mu.Unlock()
}

// Hold fails every write to key (Lock, LockAll) until the returned release is
// called; reads proceed.
func (l *repoLocker) Hold(key string) (release func()) {
	l.mu.Lock()
	if l.held == nil {
		l.held = map[string]struct{}{}
	}
	l.held[key] = struct{}{}
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		delete(l.held, key)
		l.mu.Unlock()
	}
}

// Held reports whether key is held.
func (l *repoLocker) Held(key string) bool {
	return l.Refusal(key) != nil
}

// Refusal is the answer to a write to key while it is held, or nil. A key
// is held by Hold, and by a rollback hold in its git directory
// (rollbackHoldFile), which outlives the process and lifts only when the
// operator removes the file.
func (l *repoLocker) Refusal(key string) *appError {
	if rollbackHeld(repoGitDir(key)) {
		return errRollbackHeld()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, held := l.held[key]; held {
		return errRepositoryHeld()
	}
	return nil
}

// repositoryHeldCode is the error code of a write to a held repository.
const repositoryHeldCode = "repository_held"

// errRepositoryHeld is the answer to a write to a repository held for
// maintenance outside repo-host: 503, to be retried once the hold is checked
// again (holdPollInterval).
func errRepositoryHeld() *appError {
	return &appError{
		StatusCode: http.StatusServiceUnavailable,
		Code:       repositoryHeldCode,
		Message:    "repository maintenance is finishing; retry in " + strconv.Itoa(retryAfterSeconds()) + "s",
		RetryAfter: retryAfterSeconds(),
	}
}

func retryAfterSeconds() int {
	return max(1, int((holdPollInterval+time.Second-1)/time.Second))
}
