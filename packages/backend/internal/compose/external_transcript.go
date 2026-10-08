package compose

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// TranscriptBinding is resolved from the authenticated branch session registry.
// Live means the registry has checked process lifetime and membership revocation.
// Neither transcript bytes nor caller-selected UID/home can supply this binding.
type TranscriptBinding struct {
	Scope               chat.Scope
	Session             uint32
	Participant, Source [16]byte
	// Profile is pinned by discovery, never selected by a daemon record.
	Profile string
	Live    bool
}

// TranscriptNormalize calls only the install-shipped TypeScript pure adapter.
// Its checkpoint must be stored in this receipt transaction by the provider.
// Returning error leaves the record unacknowledged for deterministic replay.
type TranscriptNormalize func(context.Context, pgx.Tx, string, TranscriptBinding, wire.Transcript) ([]chat.ExternalDraft, error)

type TranscriptIngest struct {
	Store *chat.Store
	// Resolve keys a registered process source within a terminal session.
	// One terminal can contain several agents; session alone is not an identity.
	Resolve   func(context.Context, pgx.Tx, string, uint32, [16]byte, [16]byte) (TranscriptBinding, error)
	Normalize TranscriptNormalize
	Host      transcriptAdapter
}

// Write composes with Ingestor: normalization, chat journal and machine receipt
// commit together before acknowledgment. No dispatcher or execution API is used.
func (s *TranscriptIngest) Write(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
	ack := machined.Acknowledgement{Seq: event.Seq}
	if s == nil || s.Store == nil || s.Resolve == nil || (s.Normalize == nil && s.Host == nil) {
		return ack, machined.ErrNotReady
	}
	record, err := wire.DecodeTranscript(event.Payload)
	if err != nil {
		return ack, err
	}
	binding, err := s.Resolve(ctx, tx, branch, record.Session, record.Participant, record.Source)
	if err != nil {
		return ack, err
	}
	if !binding.Live || binding.Session != record.Session || binding.Participant != record.Participant || binding.Source != record.Source || binding.Profile == "" || binding.Profile != record.Profile {
		return ack, machined.ErrUnauthorized
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	if repository != binding.Scope.RepositoryID {
		return ack, machined.ErrUnauthorized
	}
	// Reuse the store's membership fence before exposing bytes to an adapter.
	// The held row locks keep revocation serialized through receipt commit,
	// including bookkeeping records that produce no conversation entries.
	if err = s.Store.ImportExternalTx(ctx, tx, binding.Scope, branch, nil); err != nil {
		return ack, err
	}
	var drafts []chat.ExternalDraft
	stopped := false
	if s.Normalize != nil {
		drafts, err = s.Normalize(ctx, tx, branch, binding, record)
	} else {
		drafts, stopped, err = s.normalizeHost(ctx, tx, branch, binding, record, event.EventID)
	}
	if err != nil {
		return ack, err
	}
	participant := fmt.Sprintf("%x-%x-%x-%x-%x", record.Participant[:4], record.Participant[4:6], record.Participant[6:8], record.Participant[8:10], record.Participant[10:])
	for _, draft := range drafts {
		if draft.Session != fmt.Sprint(record.Session) || draft.Participant != participant || draft.Owner != fmt.Sprint(binding.Scope.UserID) || draft.SourceOffset != record.Start || draft.Profile != record.Profile {
			return ack, machined.ErrUnauthorized
		}
	}
	if err = s.Store.ImportExternalTx(ctx, tx, binding.Scope, branch, drafts); err != nil {
		return ack, err
	}
	ack.Outcome = machined.AckApplied
	if stopped {
		// The record is settled, not applied: the receipt and the entry that
		// says the import stopped commit together, and the guest reads the
		// rejection as the instruction to stop that source.
		ack.Outcome = machined.AckRejected
	}
	return ack, nil
}
