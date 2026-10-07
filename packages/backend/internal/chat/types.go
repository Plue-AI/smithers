package chat

import (
	"encoding/json"
	"errors"

	"github.com/smithersai/smithers/packages/backend/ports"
)

var (
	ErrNotFound       = errors.New("chat turn not found")
	ErrForbidden      = errors.New("chat turn is not available to this owner")
	ErrRetired        = errors.New("chat turn is retired")
	ErrConflict       = errors.New("chat request conflicts with an existing request")
	ErrProducerBusy   = errors.New("chat producer lease is active")
	ErrProducerFenced = errors.New("chat producer is fenced")
	ErrCursorConflict = errors.New("chat cursor does not name a committed boundary")
	ErrTerminal       = errors.New("chat turn is terminal")
	ErrInvalidFrame   = errors.New("invalid chat frame")
	ErrInvalidRequest = errors.New("invalid chat request")
	ErrLimit          = errors.New("chat journal limit reached")
	ErrCorrupt        = errors.New("chat journal is corrupt")
	ErrUncertain      = errors.New("chat provider outcome is uncertain")
)

type State string

const (
	StateAccepted  State = "accepted"
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateCompleted State = "completed"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
	StateUncertain State = "uncertain"
	StateRetired   State = "retired"
)

func (s State) Terminal() bool {
	return s == StateCompleted || s == StateFailed || s == StateCancelled || s == StateUncertain || s == StateRetired
}

// Scope is derived from the shared authenticated request context. RepositoryID
// is optional because the main chat is account scoped and remains available
// before a repository is selected.
type Scope struct {
	RepositoryID int64
	UserID       int64
	Owner        string
}

type JournalRequest struct {
	Version int    `json:"version"`
	LegID   string `json:"legId"`
	Token   string `json:"token"`
}

// Cursor names a committed journal boundary. It is the host wire type, so a
// grant needs no field-by-field copy.
type Cursor = ports.ChatTurnCursor

type Batch struct {
	Version      int               `json:"version"`
	RunID        string            `json:"runId"`
	LegID        string            `json:"legId"`
	Batch        int64             `json:"batch"`
	From         int64             `json:"from"`
	PreviousHash string            `json:"previousHash"`
	Frames       []json.RawMessage `json:"frames"`
	Hash         string            `json:"hash"`
}

type Acceptance struct {
	Version     int     `json:"version"`
	RunID       string  `json:"runId"`
	LegID       string  `json:"legId"`
	OwnerHash   string  `json:"ownerHash"`
	AccessHash  string  `json:"accessHash"`
	RequestHash string  `json:"requestHash"`
	WriterHash  string  `json:"writerHash"`
	AcceptedAt  float64 `json:"acceptedAt"`
	Hash        string  `json:"hash"`
}

type AdmitInput struct {
	Scope   Scope
	RunID   string
	Journal JournalRequest
	Request json.RawMessage
}

type AdmitResult struct {
	Status   string `json:"status"`
	Cursor   Cursor `json:"cursor"`
	Terminal bool   `json:"terminal"`
	TurnID   string `json:"-"`
}

// ProducerGrant is the host wire grant. PortHost fills ProducerBaseURL.
type ProducerGrant = ports.ChatTurnGrant

type Candidate struct {
	Scope  Scope
	TurnID string
}

type CommitInput struct {
	TurnID     string
	Generation int64
	Token      string
	Expected   Cursor
	Frames     []json.RawMessage
}

type CommitResult struct {
	Status string `json:"status"`
	Batch  Batch  `json:"batch"`
	Cursor Cursor `json:"cursor"`
}

type ReplayInput struct {
	Scope   Scope
	RunID   string
	Journal JournalRequest
	After   *Cursor
	Limit   int
}

type ReplayResult struct {
	Status   string  `json:"status"`
	After    Cursor  `json:"after"`
	Next     Cursor  `json:"next"`
	Head     Cursor  `json:"head"`
	Terminal bool    `json:"terminal"`
	More     bool    `json:"more"`
	Batches  []Batch `json:"batches"`
}
