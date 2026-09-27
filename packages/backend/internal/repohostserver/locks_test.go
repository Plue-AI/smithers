package repohostserver

import (
	"testing"
	"time"
)

func TestRepoLockerSerializesSameKey(t *testing.T) {
	locker := newRepoLocker()
	unlock1 := locker.Lock("repo")

	acquired := make(chan struct{})
	go func() {
		unlock2 := locker.Lock("repo")
		close(acquired)
		unlock2()
	}()

	select {
	case <-acquired:
		t.Fatal("second lock acquired before first unlock")
	case <-time.After(25 * time.Millisecond):
	}

	unlock1()

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("second lock did not acquire after first unlock")
	}
}

func TestRepoLockerAllowsConcurrentReaders(t *testing.T) {
	locker := newRepoLocker()
	unlock1 := locker.RLock("repo")
	defer unlock1()

	acquired := make(chan struct{})
	go func() {
		unlock2 := locker.RLock("repo")
		close(acquired)
		unlock2()
	}()

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("second reader did not acquire while first reader held the lock")
	}
}

func TestRepoLockerWriterWaitsForReaders(t *testing.T) {
	locker := newRepoLocker()
	unlockRead := locker.RLock("repo")

	acquired := make(chan struct{})
	go func() {
		unlockWrite := locker.Lock("repo")
		close(acquired)
		unlockWrite()
	}()

	select {
	case <-acquired:
		t.Fatal("writer acquired before reader released")
	case <-time.After(25 * time.Millisecond):
	}

	unlockRead()

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("writer did not acquire after readers released")
	}
}

func TestRepoLockerRemovesEntryAfterFinalUnlock(t *testing.T) {
	locker := newRepoLocker()
	unlock := locker.Lock("repo")
	unlock()

	if len(locker.locks) != 0 {
		t.Fatalf("expected lock map to be empty, got %d entries", len(locker.locks))
	}
}

func TestRepoLockerLockAllSerializesSameKeysInAnyOrder(t *testing.T) {
	locker := newRepoLocker()
	unlock1 := locker.LockAll("repo-b", "repo-a")

	acquired := make(chan struct{})
	go func() {
		unlock2 := locker.LockAll("repo-a", "repo-b")
		close(acquired)
		unlock2()
	}()

	select {
	case <-acquired:
		t.Fatal("second multi-lock acquired before first unlock")
	case <-time.After(25 * time.Millisecond):
	}

	unlock1()

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatal("second multi-lock did not acquire after first unlock")
	}
}

// LockAll waits for every held key before it takes any lock, so a held key
// never pins the write lock of another.
func TestLockAllWaitsForHoldsBeforeLocking(t *testing.T) {
	l := newRepoLocker()
	release := l.Hold("b")
	done := make(chan struct{})
	go func() { l.LockAll("a", "b")(); close(done) }()
	time.Sleep(100 * time.Millisecond)
	read := make(chan struct{})
	go func() { l.RLock("a")(); close(read) }()
	select {
	case <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("LockAll took a's lock while b was held")
	}
	release()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("LockAll never took the locks")
	}
}
