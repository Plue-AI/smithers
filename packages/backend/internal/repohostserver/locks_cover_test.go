package repohostserver

import (
	"context"
	"testing"
)

func TestLocks_Cov_LockAllWithNoKeysReturnsUsableUnlock(t *testing.T) {
	locker := newRepoLocker()
	unlock, err := locker.LockAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	unlock()

	if len(locker.locks) != 0 {
		t.Fatalf("expected no lock entries, got %d", len(locker.locks))
	}
}
