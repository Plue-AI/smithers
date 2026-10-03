package live

import (
	"context"
	"errors"
	"testing"
	"time"
)

// These fakes isolate the wiki lifecycle, not Yrs or PostgreSQL. The shared
// document core and revision-checked transaction supply those dependencies.
type wikiTestDocument struct{ generation byte }

func (d *wikiTestDocument) Snapshot() (WikiSnapshot, error) {
	return WikiSnapshot{State: []byte{d.generation}, StateVector: []byte{d.generation}, Markdown: "merged", Authors: []string{"Ben", "Alice", "Historic editor"}}, nil
}
func (d *wikiTestDocument) Apply(actor string, update []byte) error {
	if actor == "forged" {
		return errors.New("foreign client id")
	}
	d.generation++
	return nil
}

type wikiTestStore struct {
	saved  []WikiSnapshot
	err    error
	during func()
}

func (s *wikiTestStore) Commit(_ context.Context, pageID int64, snapshot WikiSnapshot) error {
	if s.during != nil {
		s.during()
	}
	if s.err != nil {
		return s.err
	}
	s.saved = append(s.saved, snapshot)
	return nil
}

func TestWikiDocumentIdleAndContinuousDeadlines(t *testing.T) {
	// spec.md §7.4.2: 2 s idle or 10 s from oldest unpersisted update.
	for _, continuous := range []bool{false, true} {
		t.Run(map[bool]string{false: "idle", true: "continuous"}[continuous], func(t *testing.T) {
			start := time.Unix(100, 0)
			store := &wikiTestStore{}
			doc, err := OpenWikiDocument(42, &wikiTestDocument{}, store)
			if err != nil {
				t.Fatal(err)
			}
			if err = doc.Update("Ben", []byte{1}, start); err != nil {
				t.Fatal(err)
			}
			if err = doc.Update("Alice", []byte{1}, start); err != nil {
				t.Fatal(err)
			}
			if continuous {
				for i := 1; i < 1000; i++ {
					now := start.Add(time.Duration(i) * 10 * time.Millisecond)
					if err = doc.Update("Alice", []byte{1}, now); err != nil {
						t.Fatal(err)
					}
					if sv, err := doc.Flush(context.Background(), now); err != nil || sv != nil {
						t.Fatalf("premature save: %v %v", sv, err)
					}
				}
			}
			deadline := start.Add(2 * time.Second)
			if continuous {
				deadline = start.Add(10 * time.Second)
			}
			if sv, err := doc.Flush(context.Background(), deadline.Add(-time.Nanosecond)); err != nil || sv != nil {
				t.Fatalf("premature save: %v %v", sv, err)
			}
			sv, err := doc.Flush(context.Background(), deadline)
			if err != nil || sv == nil || len(store.saved) != 1 {
				t.Fatalf("missing save: %v %v %d", sv, err, len(store.saved))
			}
			if len(store.saved[0].Authors) != 2 || store.saved[0].Authors[0] != "Ben" || store.saved[0].Authors[1] != "Alice" {
				t.Fatal("lost period authors")
			}
			if sv, err := doc.Flush(context.Background(), deadline.Add(time.Hour)); err != nil || sv != nil {
				t.Fatal("saved unchanged document")
			}
		})
	}
}

func TestWikiDocumentCommitBeforeSavedAndRetry(t *testing.T) {
	start := time.Unix(100, 0)
	store := &wikiTestStore{err: errors.New("commit failed")}
	doc, _ := OpenWikiDocument(42, &wikiTestDocument{}, store)
	_ = doc.Update("Ben", []byte{1}, start)
	now := start.Add(2 * time.Second)
	if sv, err := doc.Flush(context.Background(), now); err == nil || sv != nil {
		t.Fatal("acknowledged failed commit")
	}
	store.err = nil
	sv, err := doc.Flush(context.Background(), now)
	if err != nil || len(sv) != 1 || sv[0] != 1 || len(store.saved) != 1 {
		t.Fatalf("retry duplicated edit: %v %v", sv, err)
	}
}

func TestWikiDocumentUpdatesDuringCommitKeepTheirOwnDeadline(t *testing.T) {
	start := time.Unix(100, 0)
	store := &wikiTestStore{}
	doc, _ := OpenWikiDocument(42, &wikiTestDocument{}, store)
	_ = doc.Update("Ben", []byte{1}, start)
	store.during = func() {
		if sv, err := doc.Flush(context.Background(), start.Add(2*time.Second)); err != nil || sv != nil {
			t.Fatal("concurrent commit")
		}
		if err := doc.Update("Alice", []byte{2}, start.Add(3*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	sv, err := doc.Flush(context.Background(), start.Add(2*time.Second))
	if err != nil || sv[0] != 1 {
		t.Fatalf("saved beyond committed snapshot: %v %v", sv, err)
	}
	store.during = nil
	if sv, err := doc.Flush(context.Background(), start.Add(5*time.Second-time.Nanosecond)); err != nil || sv != nil {
		t.Fatal("early second save")
	}
	sv, err = doc.Flush(context.Background(), start.Add(5*time.Second))
	if err != nil || sv[0] != 2 || len(store.saved) != 2 {
		t.Fatal("lost concurrent update")
	}
}

func TestWikiDocumentFailClosedAndCloseRetainsPending(t *testing.T) {
	for _, page := range []int64{0, -1} {
		if _, err := OpenWikiDocument(page, &wikiTestDocument{}, &wikiTestStore{}); err == nil {
			t.Fatal("invalid page")
		}
	}
	if _, err := OpenWikiDocument(42, nil, &wikiTestStore{}); err == nil {
		t.Fatal("missing shared core")
	}
	if _, err := OpenWikiDocument(42, &wikiTestDocument{}, nil); err == nil {
		t.Fatal("missing persistence")
	}
	start := time.Unix(100, 0)
	store := &wikiTestStore{}
	doc, _ := OpenWikiDocument(42, &wikiTestDocument{}, store)
	if err := doc.Update("", []byte{1}, start); err == nil {
		t.Fatal("anonymous update")
	}
	if err := doc.Update("forged", []byte{1}, start); err == nil {
		t.Fatal("forged update")
	}
	if err := doc.Update("Ben", make([]byte, (1<<20)+1), start); err == nil {
		t.Fatal("oversize update")
	}
	if err := doc.Update("Ben", nil, start); err == nil {
		t.Fatal("empty update")
	}
	if doc.Pending() {
		t.Fatal("rejected input dirtied page")
	}
	_ = doc.Update("Ben", []byte{1}, start)
	doc.Close()
	if !doc.Pending() {
		t.Fatal("close discarded unsaved updates")
	}
	if err := doc.Update("Ben", []byte{2}, start); err == nil {
		t.Fatal("write after close")
	}
	sv, err := doc.Flush(context.Background(), start.Add(2*time.Second))
	if err != nil || sv[0] != 1 {
		t.Fatal("closed page did not finish persistence")
	}
}

type wikiSnapshotAuthority struct {
	wikiTestDocument
	snapshot WikiSnapshot
	err      error
}

func (a *wikiSnapshotAuthority) Snapshot() (WikiSnapshot, error) { return a.snapshot, a.err }

func TestWikiDocumentSnapshotFailuresRetainEdits(t *testing.T) {
	// Limits transcribed from T-COL-09 Scope: Markdown/update 1 MiB, state 8 MiB.
	good := WikiSnapshot{State: []byte{1}, StateVector: []byte{1}, Markdown: "valid", Authors: []string{"Ben"}}
	cases := []struct {
		name     string
		snapshot WikiSnapshot
		err      error
	}{
		{"snapshot failed", good, errors.New("native unavailable")},
		{"empty state", WikiSnapshot{StateVector: []byte{1}}, nil},
		{"oversize state", WikiSnapshot{State: make([]byte, (8<<20)+1), StateVector: []byte{1}}, nil},
		{"empty vector", WikiSnapshot{State: []byte{1}}, nil},
		{"oversize vector", WikiSnapshot{State: []byte{1}, StateVector: make([]byte, (8<<20)+1)}, nil},
		{"oversize markdown", WikiSnapshot{State: []byte{1}, StateVector: []byte{1}, Markdown: string(make([]byte, (1<<20)+1))}, nil},
		{"invalid utf8", WikiSnapshot{State: []byte{1}, StateVector: []byte{1}, Markdown: string([]byte{0xff})}, nil},
		{"unknown author", WikiSnapshot{State: []byte{1}, StateVector: []byte{1}, Authors: []string{"Alice"}}, nil},
	}
	start := time.Unix(100, 0)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			core := &wikiSnapshotAuthority{snapshot: tc.snapshot, err: tc.err}
			store := &wikiTestStore{}
			doc, _ := OpenWikiDocument(42, core, store)
			_ = doc.Update("Ben", []byte{1}, start)
			if sv, err := doc.Flush(context.Background(), start.Add(2*time.Second)); err == nil || sv != nil || len(store.saved) != 0 || !doc.Pending() {
				t.Fatal("acknowledged invalid snapshot")
			}
			core.snapshot, core.err = good, nil
			if sv, err := doc.Flush(context.Background(), start.Add(2*time.Second)); err != nil || len(sv) != 1 || doc.Pending() {
				t.Fatal("lost edits after snapshot failure")
			}
		})
	}
	// Exactly the declared limits are accepted, including a maximal update.
	core := &wikiSnapshotAuthority{snapshot: WikiSnapshot{State: make([]byte, 8<<20), StateVector: []byte{1}, Markdown: string(make([]byte, 1<<20)), Authors: []string{"Ben", "Ben"}}}
	doc, _ := OpenWikiDocument(42, core, &wikiTestStore{})
	if err := doc.Update("Ben", make([]byte, 1<<20), start); err != nil {
		t.Fatal(err)
	}
	if _, err := doc.Flush(context.Background(), start.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
}

func TestWikiDocumentFailureDuringConcurrentEditRetainsBothPeriods(t *testing.T) {
	start := time.Unix(100, 0)
	store := &wikiTestStore{err: errors.New("transaction conflict")}
	doc, _ := OpenWikiDocument(42, &wikiTestDocument{}, store)
	_ = doc.Update("Ben", []byte{1}, start)
	store.during = func() { _ = doc.Update("Alice", []byte{2}, start.Add(3*time.Second)) }
	if sv, err := doc.Flush(context.Background(), start.Add(2*time.Second)); err == nil || sv != nil {
		t.Fatal("saved failed transaction")
	}
	store.err, store.during = nil, nil
	if sv, err := doc.Flush(context.Background(), start.Add(5*time.Second)); err != nil || sv[0] != 2 || len(store.saved[0].Authors) != 2 {
		t.Fatal("lost failed period or its authors")
	}
}

func TestWikiDocumentSlowCommitDoesNotBlockTyping(t *testing.T) {
	start := time.Unix(100, 0)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	store := &wikiTestStore{during: func() { close(entered); <-release }}
	doc, _ := OpenWikiDocument(42, &wikiTestDocument{}, store)
	_ = doc.Update("Ben", []byte{1}, start)
	go func() {
		defer close(done)
		sv, err := doc.Flush(context.Background(), start.Add(2*time.Second))
		if err != nil || sv[0] != 1 {
			t.Error("wrong saved snapshot")
		}
	}()
	<-entered
	if err := doc.Update("Alice", []byte{2}, start.Add(3*time.Second)); err != nil {
		t.Error(err)
	}
	doc.Close()
	close(release)
	<-done
	if !doc.Pending() {
		t.Fatal("acknowledged edits outside the transaction")
	}
	store.during = nil
	if sv, err := doc.Flush(context.Background(), start.Add(5*time.Second)); err != nil || sv[0] != 2 || len(store.saved[1].Authors) != 1 || store.saved[1].Authors[0] != "Alice" {
		t.Fatal("period authors or update lost")
	}
}
