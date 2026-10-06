// Package jobs provides shared PostgreSQL admission, delivery receipts, and
// ordered product events for slow external operations. It deliberately does
// not model workflow nodes: canonical Flow/Control remains the execution and
// workflow-journal authority.
package jobs

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type State string

const (
	StateAccepted    State = "accepted"
	StateDispatching State = "dispatching"
	StateRunning     State = "running"
	StateWaiting     State = "waiting"
	StateCompleted   State = "completed"
	StateFailed      State = "failed"
	StateCancelled   State = "cancelled"
	StateUncertain   State = "uncertain"
)

func (state State) Terminal() bool {
	switch state {
	case StateCompleted, StateFailed, StateCancelled, StateUncertain:
		return true
	default:
		return false
	}
}

type EffectPolicy string

const (
	EffectIdempotent EffectPolicy = "idempotent"
	EffectReconcile  EffectPolicy = "reconcile"
	EffectUnsafe     EffectPolicy = "unsafe"
)

type Scope struct {
	TenantID    string
	PrincipalID string
}

func (scope Scope) validate() error {
	if strings.TrimSpace(scope.TenantID) == "" || strings.TrimSpace(scope.PrincipalID) == "" {
		return errors.New("jobs: tenant and principal are required")
	}
	return nil
}

type Admission struct {
	Scope                Scope
	Operation            string
	RequestID            string
	Payload              json.RawMessage
	AuthorizationContext json.RawMessage
	EffectPolicy         EffectPolicy
	EffectKey            string
	AvailableAt          time.Time
}

type RequestReceipt struct {
	OperationID string    `json:"operationId"`
	RequestID   string    `json:"requestId"`
	Kind        string    `json:"kind"`
	State       State     `json:"state"`
	AcceptedAt  time.Time `json:"acceptedAt"`
	Joined      bool      `json:"-"`
}

type Operation struct {
	ID                      string
	Scope                   Scope
	Operation               string
	RequestID               string
	PayloadFingerprint      [sha256.Size]byte
	Payload                 json.RawMessage
	AuthorizationContext    json.RawMessage
	State                   State
	RequestReceipt          json.RawMessage
	ExternalReceipt         json.RawMessage
	TerminalReceipt         json.RawMessage
	EffectPolicy            EffectPolicy
	EffectKey               string
	Attempt                 int
	ExternalAttempt         int
	Generation              int64
	NeedsReconciliation     bool
	CancellationRequested   bool
	CancellationRequestedAt *time.Time
	CreatedAt               time.Time
	UpdatedAt               time.Time
}

type Claim struct {
	OperationID           string
	Scope                 Scope
	Operation             string
	RequestID             string
	State                 State
	Payload               json.RawMessage
	AuthorizationContext  json.RawMessage
	ExternalReceipt       json.RawMessage
	EffectPolicy          EffectPolicy
	EffectKey             string
	Attempt               int
	ExternalAttempt       int
	Generation            int64
	Token                 string
	WorkerID              string
	LeaseExpiresAt        time.Time
	NeedsReconciliation   bool
	CancellationRequested bool
}

// DeliveryAttempt is the stable attempt identity for an external call. A
// recovered PostgreSQL claim increments Attempt/Generation for fencing, while
// an ambiguous external launch keeps the attempt committed before that call.
func (claim Claim) DeliveryAttempt() int {
	if claim.ExternalAttempt > 0 {
		return claim.ExternalAttempt
	}
	return 1
}

type Event struct {
	RepositorySequence int64 `json:",omitempty"`
	Scope              Scope
	Sequence           int64
	EventID            string
	OperationID        string
	Type               string
	State              State
	Data               json.RawMessage
	RecordedAt         time.Time
}

type ReplayPage struct {
	Events []Event
	Cursor int64
	Head   int64
	More   bool
}

type Snapshot struct {
	Scope      Scope
	Cursor     int64
	Operations []Operation
	Truncated  bool
}

type CursorExpiredError struct {
	Cursor int64
	Floor  int64
	Head   int64
}

func (err *CursorExpiredError) Error() string {
	return fmt.Sprintf("jobs: cursor %d expired; retained events start at %d (head %d)", err.Cursor, err.Floor, err.Head)
}

var (
	ErrNoWork = errors.New("jobs: no work available")
	// ErrDeferred is returned by Lease.Defer only after it has durably saved a
	// checkpoint and released the claim. RunWorker treats it as a successful
	// park rather than a handler failure.
	ErrDeferred                 = errors.New("jobs: operation deferred")
	ErrClaimLost                = errors.New("jobs: claim is stale or expired")
	ErrNotFound                 = errors.New("jobs: operation not found")
	ErrPayloadConflict          = errors.New("jobs: idempotency key reused with a different payload")
	ErrCancellationRequested    = errors.New("jobs: cancellation was requested")
	ErrCancellationNotRequested = errors.New("jobs: cancellation was not requested")
	ErrCursorAhead              = errors.New("jobs: cursor is ahead of the committed stream")
	ErrUncertainResolution      = errors.New("jobs: operation is not uncertain")
)

func canonicalJSON(value json.RawMessage, requireObject bool) (json.RawMessage, error) {
	if len(value) == 0 {
		if requireObject {
			return json.RawMessage(`{}`), nil
		}
		return nil, errors.New("jobs: payload is required")
	}
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(value))
	// Payloads and receipts can contain integer identities or exact decimals.
	// Decoding through float64 would alter both their values and fingerprints.
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return nil, fmt.Errorf("jobs: invalid JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("jobs: invalid JSON: trailing data")
	}
	if requireObject {
		if _, ok := decoded.(map[string]any); !ok {
			return nil, errors.New("jobs: JSON value must be an object")
		}
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		return nil, fmt.Errorf("jobs: canonicalize JSON: %w", err)
	}
	return encoded, nil
}

func validatePolicy(policy EffectPolicy) bool {
	return policy == EffectIdempotent || policy == EffectReconcile || policy == EffectUnsafe
}
