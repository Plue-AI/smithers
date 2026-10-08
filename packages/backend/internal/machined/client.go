package machined

import "context"

// Client is the host's branch-scoped machine boundary. Branch and actor come
// from host authorization, never from a guest frame. Implementations fence each
// call to the current boot and refuse ordinary calls until reconciliation and
// roster installation complete. WakeReconcile, SetRoster, Events and Ack must
// remain usable during admission (capture may wait for concurrent event acks).
// No method falls back to writing the host working copy.
type Client interface {
	ReadFile(context.Context, string, string, string) (File, error)
	WriteFiles(context.Context, string, []byte, []FileChange) (WriteResult, error)
	Capture(context.Context, string) (CaptureResult, error)
	WakeReconcile(context.Context, string, string) (ReconcileResult, error)
	Rebase(context.Context, string, []byte, string) (RewriteResult, error)
	ReturnToItem(context.Context, string, []byte) (RewriteResult, error)
	OpenDocument(context.Context, string, string, []byte) (DocumentStream, error)
	Sessions(string) SessionRPC
	SetRoster(context.Context, string, []SessionUser) error
	Events(string) EventStream
	Ack(context.Context, string, Acknowledgement) error
}

// ReadFile's final argument is an optional captured commit; empty reads disk.
type File struct {
	Content []byte
	Digest  string // SHA-256 hex; not a Git object id
	Mode    uint32
}

// BaseDigest nil means absent, not an unconditional write. All bases are
// compared before any write; a stale result has no applied receipts. I/O errors
// can occur after earlier writes succeed, whose receipts remain in the result.
// Nil Content deletes the file; a non-nil empty slice writes an empty file.
// An applied deletion has PostDigest "absent".
type FileChange struct {
	Path       string
	BaseDigest *string
	Content    []byte
}
type AppliedFile struct{ Path, PostDigest string }
type RacedFile struct{ Path, DisplacedDigest string }
type StaleFile struct {
	Path          string
	CurrentDigest *string // nil means the path is now absent
}
type WriteResult struct {
	// Preflight certifies that refusal preceded every batch mutation.
	Preflight bool
	Applied   []AppliedFile
	Raced     []RacedFile // displaced bytes are retained; an applied write never rolls back
	Stale     *StaleFile
}
type CaptureResult struct {
	Head, Tree       string
	FlushedDocuments uint16
}
type ReconcileOutcome string

const (
	ReconcileUnchanged ReconcileOutcome = "unchanged"
	ReconcileMoved     ReconcileOutcome = "moved"
	ReconcileConflict  ReconcileOutcome = "conflict"
)

type ReconcileResult struct {
	Outcome ReconcileOutcome
	Head    string
	Paths   []string
}
type RewriteResult struct {
	ReceiptID string `json:"receipt_id,omitempty"`
	Head      string
	Paths     []string
	Inspected bool
}

// DocumentStream is the authenticated daemon peer. Close sends close_doc and
// unblocks Receive; cancellation must unblock both Send and Receive.
type DocumentStream interface {
	Send(context.Context, []byte) error
	Receive(context.Context) ([]byte, error)
	Close() error
}

// DocumentRPC is the existing branch-bound document consumer contract.
type DocumentRPC interface {
	OpenDocument(context.Context, string, []byte) (DocumentStream, error)
}

// Documents adapts a branch-scoped Client to the live document consumer without
// defining another transport or engine. Authorization still belongs to live.
func Documents(client Client, branch string) DocumentRPC {
	return branchDocuments{client, branch}
}

type branchDocuments struct {
	client Client
	branch string
}

func (d branchDocuments) OpenDocument(ctx context.Context, path string, actor []byte) (DocumentStream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if d.client == nil {
		return nil, ErrNotReady
	}
	return d.client.OpenDocument(ctx, d.branch, path, actor)
}

// EventStream is one ordered, boot-bound stream. Receive is cancellable; Close
// releases the subscription and unblocks Receive. Unacked events replay on the
// next connection. Payload is the validated ADR 0004 Event or Hint union, not a
// second event schema; durable events have nonzero Seq and EventID, hints do not.
type EventStream interface {
	Receive(context.Context) (Event, error)
	Close() error
}
type Event struct {
	Seq     uint64
	EventID [16]byte
	Payload []byte // inner event/hint union; sequence and ID come from the authenticated envelope
}
type AckOutcome uint8

const (
	AckApplied        AckOutcome = 1
	AckDuplicate      AckOutcome = 2
	AckMissingObjects AckOutcome = 3
	AckRejected       AckOutcome = 4
	AckStaleBase      AckOutcome = 5
)

type Acknowledgement struct {
	Seq         uint64
	Outcome     AckOutcome
	OIDs, Haves []string
	Error       *SessionError
}
