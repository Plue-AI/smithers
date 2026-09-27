package repohostserver

import (
	"sort"
	"sync"
)

type repoLocker struct {
	mu    sync.Mutex
	locks map[string]*repoLockEntry
	// held gates the write lock of held keys (Hold); each channel closes
	// when its hold is released.
	held map[string]chan struct{}
}

type repoLockEntry struct {
	mu   sync.RWMutex
	refs int
}

func newRepoLocker() *repoLocker {
	return &repoLocker{locks: map[string]*repoLockEntry{}}
}

// Lock takes key's write lock, once key is not held (Hold).
func (l *repoLocker) Lock(key string) func() {
	l.awaitUnheld(key)
	return l.lock(key)
}

// awaitUnheld waits until none of keys is held. Holds are only taken before
// any lock is (Hold), so none returns once this does.
func (l *repoLocker) awaitUnheld(keys ...string) {
	for _, key := range keys {
		l.mu.Lock()
		gate := l.held[key]
		l.mu.Unlock()
		if gate != nil {
			<-gate
		}
	}
}

func (l *repoLocker) lock(key string) func() {
	entry := l.acquire(key)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		l.release(key, entry)
	}
}

func (l *repoLocker) LockAll(keys ...string) func() {
	if len(keys) == 0 {
		return func() {}
	}

	ordered := append([]string(nil), keys...)
	sort.Strings(ordered)
	deduped := ordered[:0]
	for _, key := range ordered {
		if len(deduped) == 0 || deduped[len(deduped)-1] != key {
			deduped = append(deduped, key)
		}
	}

	// Waiting for every hold first keeps a held key from pinning the write
	// lock of one taken before it.
	l.awaitUnheld(deduped...)
	unlocks := make([]func(), 0, len(deduped))
	for _, key := range deduped {
		unlocks = append(unlocks, l.lock(key))
	}
	return func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}
}

func (l *repoLocker) RLock(key string) func() {
	entry := l.acquire(key)
	entry.mu.RLock()
	return func() {
		entry.mu.RUnlock()
		l.release(key, entry)
	}
}

func (l *repoLocker) acquire(key string) *repoLockEntry {
	l.mu.Lock()
	entry := l.locks[key]
	if entry == nil {
		entry = &repoLockEntry{}
		l.locks[key] = entry
	}
	entry.refs++
	l.mu.Unlock()
	return entry
}

func (l *repoLocker) release(key string, entry *repoLockEntry) {
	l.mu.Lock()
	entry.refs--
	if entry.refs == 0 {
		delete(l.locks, key)
	}
	l.mu.Unlock()
}

// Hold holds key's write lock off, without taking the lock itself: writers
// wait in Lock until the returned release is called, while readers proceed.
// Unlike a held read lock, a waiting writer does not queue ahead of readers.
func (l *repoLocker) Hold(key string) (release func()) {
	gate := make(chan struct{})
	l.mu.Lock()
	if l.held == nil {
		l.held = map[string]chan struct{}{}
	}
	l.held[key] = gate
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		delete(l.held, key)
		l.mu.Unlock()
		close(gate)
	}
}

// Held reports whether key is held.
func (l *repoLocker) Held(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.held[key] != nil
}
