package compose

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
)

// TranscriptBinding is who a transcript source belongs to, resolved from the
// host's own record of the terminal session it opened. Neither transcript
// bytes nor a daemon-supplied uid or home can supply it.
type TranscriptBinding struct {
	Scope               chat.Scope
	Session             uint32
	Participant, Source [16]byte
	// Profile is pinned by discovery at the source's first record, never
	// chosen again by a later one.
	Profile string
	// Boot is the machine boot the session belongs to. A source never
	// outlives its boot: the agent process died with it.
	Boot string
	// Live is false when the registry no longer vouches for the session.
	Live bool
}

// TranscriptNormalize calls only the install-shipped TypeScript pure adapter.
// Its checkpoint must be stored in this receipt transaction by the provider.
// Returning error leaves the record unacknowledged for deterministic replay.
type TranscriptNormalize func(context.Context, pgx.Tx, string, TranscriptBinding, wire.Transcript) ([]chat.ExternalDraft, error)

type TranscriptIngest struct {
	Store *chat.Store
	// Resolve keys a registered process source within a terminal session.
	// One terminal can contain several agents; session alone is not an identity.
	// machined.ErrUnauthorized means the record can never be this install's to
	// import; any other error leaves the record unacknowledged for replay.
	Resolve   func(context.Context, pgx.Tx, string, wire.Transcript) (TranscriptBinding, error)
	Normalize TranscriptNormalize
	Host      transcriptAdapter
}

// Write composes with Ingestor: normalization, chat journal and machine receipt
// commit together before acknowledgment. No dispatcher or execution API is used.
//
// A record settles in one of three ways. Applied: its entries and checkpoint
// commit with the receipt. Rejected: it can never be imported (a source that is
// not its session's, an owner who is no longer a member, a retired or stopped
// generation, a record that changed after it committed), so nothing is written
// for it but the receipt, and the guest's outbox moves on instead of replaying
// one record forever in front of every other event on the branch. Error: the
// host could not decide yet; nothing commits and the record replays.
func (s *TranscriptIngest) Write(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.Acknowledgement, error) {
	ack := machined.Acknowledgement{Seq: event.Seq}
	if s == nil || s.Store == nil || s.Resolve == nil || (s.Normalize == nil && s.Host == nil) {
		return ack, machined.ErrNotReady
	}
	record, err := wire.DecodeTranscript(event.Payload)
	if err != nil {
		return ack, err
	}
	// Every rejection below happens before this transaction writes anything.
	rejected := machined.Acknowledgement{Seq: event.Seq, Outcome: machined.AckRejected}
	binding, err := s.Resolve(ctx, tx, branch, record)
	if errors.Is(err, machined.ErrUnauthorized) {
		return rejected, nil
	}
	if err != nil {
		return ack, err
	}
	if !binding.Live || binding.Session != record.Session || binding.Participant != record.Participant || binding.Source != record.Source || binding.Profile == "" || binding.Profile != record.Profile {
		return rejected, nil
	}
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	if repository != binding.Scope.RepositoryID {
		return rejected, nil
	}
	// Reuse the store's membership fence before exposing bytes to an adapter.
	// The held row locks keep revocation serialized through receipt commit,
	// including bookkeeping records that produce no conversation entries.
	// A removed owner's records are never imported; what was shared stays.
	if err = s.Store.ImportExternalTx(ctx, tx, binding.Scope, branch, nil); errors.Is(err, chat.ErrForbidden) {
		return rejected, nil
	} else if err != nil {
		return ack, err
	}
	var drafts []chat.ExternalDraft
	stopped := false
	if s.Normalize != nil {
		drafts, err = s.Normalize(ctx, tx, branch, binding, record)
	} else {
		drafts, stopped, err = s.normalizeHost(ctx, tx, branch, binding, record, event.EventID)
		// Both are decided from committed checkpoints before any write: the
		// generation was retired or has a gap, or the bytes at a committed
		// range are not the ones that committed.
		if errors.Is(err, chat.ErrCursorConflict) || errors.Is(err, chat.ErrConflict) {
			return rejected, nil
		}
	}
	if err != nil {
		return ack, err
	}
	participant := fmt.Sprintf("%x-%x-%x-%x-%x", record.Participant[:4], record.Participant[4:6], record.Participant[6:8], record.Participant[8:10], record.Participant[10:])
	for _, draft := range drafts {
		// The adapter stamps the registration it was given. Anything else is
		// a host fault, not a verdict on the record: nothing is acknowledged.
		if draft.Session != fmt.Sprint(record.Session) || draft.Participant != participant || draft.Owner != fmt.Sprint(binding.Scope.UserID) || draft.SourceOffset != record.Start || draft.Profile != record.Profile {
			return ack, chat.ErrInvalidFrame
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
