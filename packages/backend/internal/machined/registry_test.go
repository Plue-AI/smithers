package machined

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

type testStream struct{ closed atomic.Int32 }

func (s *testStream) Close() error { s.closed.Add(1); return nil }

func expectError(t *testing.T, got, want error) {
	t.Helper()
	if !errors.Is(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRegistryBootAndConnectionFences(t *testing.T) {
	var r Registry
	a, b := [16]byte{1}, [16]byte{2}
	expectError(t, r.BindBoot("A", "machine-A", a, []byte("credential-A")), nil)
	expectError(t, r.BindBoot("B", "machine-B", b, []byte("credential-B")), nil)
	firstStream := new(testStream)
	first, err := r.Admit(a, []byte("credential-A"), firstStream)
	expectError(t, err, nil)
	expectError(t, first.RequireReady("A"), ErrNotReady)
	expectError(t, first.RequireReady("B"), ErrUnauthorized)
	expectError(t, first.Reconciled(), nil)
	expectError(t, first.RequireReady("A"), nil)
	for _, id := range [][16]byte{a, b, {9}} {
		bad := new(testStream)
		_, err := r.Admit(id, []byte("forged"), bad)
		expectError(t, err, ErrUnauthorized)
		if bad.closed.Load() != 1 || firstStream.closed.Load() != 0 {
			t.Fatal("refusal disturbed live connection or leaked newcomer")
		}
	}
	cross := new(testStream)
	_, err = r.Admit(b, []byte("credential-A"), cross)
	expectError(t, err, ErrUnauthorized)
	secondStream := new(testStream)
	second, err := r.Admit(a, []byte("credential-A"), secondStream)
	expectError(t, err, nil)
	if firstStream.closed.Load() != 1 {
		t.Fatal("half-open predecessor was not closed immediately")
	}
	expectError(t, first.Reconciled(), ErrUnauthorized)
	expectError(t, first.RequireReady("A"), ErrUnauthorized)
	expectError(t, first.Close(), nil)
	expectError(t, second.RequireReady("A"), ErrNotReady)
	expectError(t, second.Reconciled(), nil)
	expectError(t, second.RequireReady("A"), nil)
	newBoot := [16]byte{3}
	expectError(t, r.BindBoot("A", "machine-A", newBoot, []byte("credential-new")), nil)
	if secondStream.closed.Load() != 1 {
		t.Fatal("rotation did not close previous boot")
	}
	expectError(t, second.RequireReady("A"), ErrUnauthorized)
	oldStream := new(testStream)
	_, err = r.Admit(a, []byte("credential-A"), oldStream)
	expectError(t, err, ErrUnauthorized)
	if oldStream.closed.Load() != 1 {
		t.Fatal("revoked boot stream leaked")
	}
	expectError(t, r.BindBoot("A", "machine-A", a, []byte("credential-A")), ErrUnauthorized)
	latest, err := r.Admit(newBoot, []byte("credential-new"), new(testStream))
	expectError(t, err, nil)
	expectError(t, latest.RequireReady("A"), ErrNotReady)
	expectError(t, latest.Reconciled(), nil)
	expectError(t, latest.Close(), nil)
	expectError(t, latest.Reconciled(), ErrUnauthorized)
	expectError(t, latest.RequireReady("A"), ErrUnauthorized)
	if firstStream.closed.Load() != 1 {
		t.Fatal("predecessor closed more than once")
	}
}

func TestRegistryRefusesInvalidBindings(t *testing.T) {
	for _, tc := range []struct {
		branch, machine string
		id              [16]byte
		credential      []byte
	}{
		{"", "M", [16]byte{1}, []byte("token")},
		{"A", "", [16]byte{1}, []byte("token")},
		{"A", "M", [16]byte{}, []byte("token")},
		{"A", "M", [16]byte{1}, nil},
		{"A", "M", [16]byte{1}, make([]byte, 1025)},
	} {
		var r Registry
		expectError(t, r.BindBoot(tc.branch, tc.machine, tc.id, tc.credential), ErrUnauthorized)
		if len(r.branches) != 0 || len(r.boots) != 0 {
			t.Fatal("invalid binding mutated authority")
		}
	}
	var r Registry
	_, err := r.Admit([16]byte{1}, []byte("token"), nil)
	expectError(t, err, ErrUnauthorized)
	for _, token := range [][]byte{nil, make([]byte, 1025)} {
		s := new(testStream)
		_, err := r.Admit([16]byte{1}, token, s)
		expectError(t, err, ErrUnauthorized)
		if s.closed.Load() != 1 {
			t.Fatal("invalid newcomer leaked")
		}
	}
	token := make([]byte, 1024)
	expectError(t, r.BindBoot("A", "M", [16]byte{1}, token), nil)
	// Registration owns a digest rather than the caller's mutable token slice.
	token[0] = 1
	_, err = r.Admit([16]byte{1}, token, new(testStream))
	expectError(t, err, ErrUnauthorized)
	token[0] = 0
	c, err := r.Admit([16]byte{1}, token, new(testStream))
	expectError(t, err, nil)
	expectError(t, c.Close(), nil)
}

func TestRegistryConcurrentReplacement(t *testing.T) {
	var r Registry
	expectError(t, r.BindBoot("A", "M", [16]byte{1}, []byte("token")), nil)
	var wg sync.WaitGroup
	streams := make([]testStream, 100)
	connections := make([]*Connection, len(streams))
	for i := range streams {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var err error
			connections[i], err = r.Admit([16]byte{1}, []byte("token"), &streams[i])
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	open := 0
	for i, c := range connections {
		if streams[i].closed.Load() == 0 {
			open++
			expectError(t, c.Reconciled(), nil)
			expectError(t, c.RequireReady("A"), nil)
		} else {
			expectError(t, c.Reconciled(), ErrUnauthorized)
		}
	}
	if open != 1 {
		t.Fatalf("%d live connections, want 1", open)
	}
	for _, c := range connections {
		expectError(t, c.Close(), nil)
	}
	for i := range streams {
		if streams[i].closed.Load() != 1 {
			t.Fatal("stream closed more than once")
		}
	}
}
