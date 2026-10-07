package machinedfake_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/machinedfake"
)

// Compile the existing document and session consumers against the shared client.
var (
	_ machined.Client  = (*machinedfake.Client)(nil)
	_ live.DocumentRPC = (*machinedfake.Documents)(nil)
	_ live.DocumentRPC = machined.Documents((*machinedfake.Client)(nil), "branch")
)

func TestClientUnavailableAndCancellation(t *testing.T) {
	for _, client := range []*machinedfake.Client{nil, {}} {
		calls := []func(context.Context) error{
			func(ctx context.Context) error { _, e := client.ReadFile(ctx, "b", "p", ""); return e },
			func(ctx context.Context) error { _, e := client.WriteFiles(ctx, "b", nil, nil); return e },
			func(ctx context.Context) error { _, e := client.Capture(ctx, "b"); return e },
			func(ctx context.Context) error { _, e := client.WakeReconcile(ctx, "b", "head"); return e },
			func(ctx context.Context) error { _, e := client.Rebase(ctx, "b", nil, "head"); return e },
			func(ctx context.Context) error { _, e := client.ReturnToItem(ctx, "b", nil); return e },
			func(ctx context.Context) error {
				_, e := machined.Documents(client, "b").OpenDocument(ctx, "p", nil)
				return e
			},
			func(ctx context.Context) error { return client.SetRoster(ctx, "b", nil) },
			func(ctx context.Context) error { return client.Ack(ctx, "b", machined.Acknowledgement{}) },
			func(ctx context.Context) error {
				_, e := client.Sessions("b").CallSession(ctx, machined.SessionCall{})
				return e
			},
			func(ctx context.Context) error { _, e := client.Events("b").Receive(ctx); return e },
		}
		cancelled, cancel := context.WithCancel(t.Context())
		cancel()
		for i, call := range calls {
			if e := call(t.Context()); !errors.Is(e, machined.ErrNotReady) {
				t.Fatalf("call %d: %v", i, e)
			}
			if e := call(cancelled); !errors.Is(e, context.Canceled) {
				t.Fatalf("cancelled call %d: %v", i, e)
			}
		}
		if e := client.Events("b").Close(); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := machined.Documents(nil, "b").OpenDocument(t.Context(), "p", nil); !errors.Is(e, machined.ErrNotReady) {
		t.Fatal(e)
	}
}

type eventStream struct{ event machined.Event }

func (s *eventStream) Receive(context.Context) (machined.Event, error) { return s.event, nil }
func (*eventStream) Close() error                                      { return nil }

type sessionRPC struct{ call machined.SessionCall }

func (s *sessionRPC) CallSession(_ context.Context, call machined.SessionCall) (machined.SessionResult, error) {
	s.call = call
	return machined.SessionResult{Session: 7}, nil
}

func TestRegistryClientConsumers(t *testing.T) {
	ctx := t.Context()
	checkBranch := func(branch string) {
		t.Helper()
		if branch != "branch" {
			t.Fatalf("wrong branch %q", branch)
		}
	}
	actor := []byte("authorized principal")
	checkActor := func(got []byte) {
		t.Helper()
		if !reflect.DeepEqual(got, actor) {
			t.Fatalf("actor %q", got)
		}
	}
	base := "base-digest"
	changes := []machined.FileChange{{Path: "a", BaseDigest: &base, Content: []byte("new")}, {Path: "b"}, {Path: "c"}}
	// A stale later file must not hide the applied/raced receipt or suggest rollback.
	receipt := machined.WriteResult{Applied: []machined.AppliedFile{{Path: "a", PostDigest: "new-digest"}}, Raced: []machined.RacedFile{{Path: "a", DisplacedDigest: "outside-digest"}}, Stale: &machined.StaleFile{Path: "b"}}
	stream := &eventStream{machined.Event{Seq: 9, EventID: [16]byte{3}, Payload: []byte{4}}}
	sessions := &sessionRPC{}
	docs := &machinedfake.Documents{}
	roster := []machined.SessionUser{{Login: "maya", UID: 20000}}
	ack := machined.Acknowledgement{Seq: 9, Outcome: machined.AckMissingObjects, OIDs: []string{"missing"}, Haves: []string{"head"}}
	seen := map[string]bool{}
	client := &machinedfake.Client{
		OnReadFile: func(_ context.Context, b, p, at string) (machined.File, error) {
			checkBranch(b)
			if p != "a" || at != "commit" {
				t.Fatal(p, at)
			}
			seen["read"] = true
			return machined.File{Content: []byte("old"), Digest: base, Mode: 0644}, nil
		},
		OnWriteFiles: func(_ context.Context, b string, a []byte, c []machined.FileChange) (machined.WriteResult, error) {
			checkBranch(b)
			checkActor(a)
			if !reflect.DeepEqual(c, changes) {
				t.Fatal(c)
			}
			seen["write"] = true
			return receipt, nil
		},
		OnCapture: func(_ context.Context, b string) (machined.CaptureResult, error) {
			checkBranch(b)
			seen["capture"] = true
			return machined.CaptureResult{Head: "head", Tree: "tree", FlushedDocuments: 2}, nil
		},
		OnWakeReconcile: func(_ context.Context, b, h string) (machined.ReconcileResult, error) {
			checkBranch(b)
			if h != "head" {
				t.Fatal(h)
			}
			seen["wake"] = true
			return machined.ReconcileResult{Outcome: machined.ReconcileConflict, Paths: []string{"a"}}, nil
		},
		OnRebase: func(_ context.Context, b string, a []byte, h string) (machined.RewriteResult, error) {
			checkBranch(b)
			checkActor(a)
			if h != "onto" {
				t.Fatal(h)
			}
			seen["rebase"] = true
			return machined.RewriteResult{Head: "rebased"}, nil
		},
		OnReturnToItem: func(_ context.Context, b string, a []byte) (machined.RewriteResult, error) {
			checkBranch(b)
			checkActor(a)
			seen["return"] = true
			return machined.RewriteResult{Head: "item"}, nil
		},
		OnOpenDocument: func(ctx context.Context, b, p string, a []byte) (machined.DocumentStream, error) {
			checkBranch(b)
			checkActor(a)
			seen["doc"] = true
			return docs.OpenDocument(ctx, p, a)
		},
		OnSetRoster: func(_ context.Context, b string, m []machined.SessionUser) error {
			checkBranch(b)
			if !reflect.DeepEqual(m, roster) {
				t.Fatal(m)
			}
			seen["roster"] = true
			return nil
		},
		OnAck: func(_ context.Context, b string, a machined.Acknowledgement) error {
			checkBranch(b)
			if !reflect.DeepEqual(a, ack) {
				t.Fatal(a)
			}
			seen["ack"] = true
			return nil
		},
		OnEvents:   func(b string) machined.EventStream { checkBranch(b); seen["events"] = true; return stream },
		OnSessions: func(b string) machined.SessionRPC { checkBranch(b); seen["sessions"] = true; return sessions },
	}
	var consumer machined.Client = client
	if f, e := consumer.ReadFile(ctx, "branch", "a", "commit"); e != nil || string(f.Content) != "old" || f.Digest != base || f.Mode != 0644 {
		t.Fatal(f, e)
	}
	if r, e := consumer.WriteFiles(ctx, "branch", actor, changes); e != nil || !reflect.DeepEqual(r, receipt) {
		t.Fatal(r, e)
	}
	if r, e := consumer.Capture(ctx, "branch"); e != nil || r.Head != "head" || r.Tree != "tree" || r.FlushedDocuments != 2 {
		t.Fatal(r, e)
	}
	if r, e := consumer.WakeReconcile(ctx, "branch", "head"); e != nil || r.Outcome != machined.ReconcileConflict || !reflect.DeepEqual(r.Paths, []string{"a"}) {
		t.Fatal(r, e)
	}
	if r, e := consumer.Rebase(ctx, "branch", actor, "onto"); e != nil || r.Head != "rebased" {
		t.Fatal(r, e)
	}
	if r, e := consumer.ReturnToItem(ctx, "branch", actor); e != nil || r.Head != "item" {
		t.Fatal(r, e)
	}
	doc, e := machined.Documents(consumer, "branch").OpenDocument(ctx, "a", actor)
	if e != nil {
		t.Fatal(e)
	}
	if e = doc.Close(); e != nil {
		t.Fatal(e)
	}
	if e := consumer.SetRoster(ctx, "branch", roster); e != nil {
		t.Fatal(e)
	}
	if r, e := consumer.Events("branch").Receive(ctx); e != nil || !reflect.DeepEqual(r, stream.event) {
		t.Fatal(r, e)
	}
	if e := consumer.Ack(ctx, "branch", ack); e != nil {
		t.Fatal(e)
	}
	var registry machined.Registry
	if e := registry.BindBoot("branch", "machine", [16]byte{1}, []byte("credential")); e != nil {
		t.Fatal(e)
	}
	connection, e := registry.Admit([16]byte{1}, []byte("credential"), stream)
	if e != nil {
		t.Fatal(e)
	}
	defer connection.Close()
	sessionConsumer := machined.NewSessions(connection, "branch", consumer.Sessions("branch")).WithActor([]byte("actor-reference1"), "")
	if _, e := sessionConsumer.OpenSession(ctx, roster[0], machined.SessionPTY, nil, nil); e == nil {
		t.Fatal("unreconciled session admitted")
	}
	if e := connection.Reconciled(); e != nil {
		t.Fatal(e)
	}
	if id, e := sessionConsumer.OpenSession(ctx, roster[0], machined.SessionPTY, nil, nil); e != nil || id != 7 {
		t.Fatal(id, e)
	}
	if sessions.call.User == nil || *sessions.call.User != roster[0] {
		t.Fatal(sessions.call)
	}
	if len(seen) != 11 {
		t.Fatal(seen)
	}
}

func TestClientPreservesPartialWriteOnTransportFailure(t *testing.T) {
	failure := errors.New("link closed after first write")
	receipt := machined.WriteResult{Applied: []machined.AppliedFile{{Path: "saved", PostDigest: "digest"}}, Raced: []machined.RacedFile{{Path: "saved", DisplacedDigest: "outside"}}}
	calls := 0
	client := &machinedfake.Client{OnWriteFiles: func(context.Context, string, []byte, []machined.FileChange) (machined.WriteResult, error) {
		calls++
		return receipt, failure
	}}
	got, err := client.WriteFiles(t.Context(), "b", []byte("person"), nil)
	if !errors.Is(err, failure) || !reflect.DeepEqual(got, receipt) {
		t.Fatal(got, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := client.WriteFiles(ctx, "b", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("cancelled call reached transport")
	}
}
