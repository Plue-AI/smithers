package compose

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"strings"
)

type transcriptAdapter interface {
	NormalizeExternalTranscript(context.Context, chat.ExternalNormalizeInput) (chat.ExternalNormalized, error)
}

type transcriptCheckpoint struct {
	Source     string          `json:"source"`
	Generation string          `json:"generation"`
	Start      uint64          `json:"start"`
	End        uint64          `json:"end"`
	Hash       string          `json:"hash"`
	State      json.RawMessage `json:"state"`
	// Stopped is the adapter's reason when this record ended the import of
	// its source generation. Later records of that generation are refused
	// without reaching the adapter.
	Stopped string `json:"stopped,omitempty"`
	// The registration every record of this source committed under. A source
	// is one agent process: its session, participant, profile, owner and boot
	// never change, so a later record that names others is not this source's.
	Session     uint32 `json:"session,omitempty"`
	Participant string `json:"participant,omitempty"`
	Profile     string `json:"profile,omitempty"`
	Owner       int64  `json:"owner,omitempty"`
	Boot        string `json:"boot,omitempty"`
}

// normalizeHost returns the record's drafts and whether the source generation
// is stopped. A stopped record commits with a rejected receipt, so the guest's
// outbox moves on and the daemon stops reading that source.
func (s *TranscriptIngest) normalizeHost(ctx context.Context, tx pgx.Tx, branch string, binding TranscriptBinding, record wire.Transcript, eventID [16]byte) ([]chat.ExternalDraft, bool, error) {
	// The adapters use JS numbers for byte offsets. Reject unrepresentable
	// offsets before sending any record rather than rounding its source identity.
	if record.End > 9007199254740991 {
		return nil, false, wire.BadValue
	}
	source := uuid.UUID(record.Source).String()
	generation := fmt.Sprint(record.Generation)
	canonical, err := wire.EncodeTranscript(record)
	if err != nil {
		return nil, false, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(canonical))
	rows, err := tx.Query(ctx, `WITH source AS (
 SELECT transcript_checkpoint AS checkpoint FROM machine_event_receipts
 WHERE workspace_id=$1 AND transcript_checkpoint->>'source'=$2 AND transcript_checkpoint->>'generation'=$3 AND outcome IN ('applied','pending')
 ), latest AS (SELECT checkpoint FROM source ORDER BY (checkpoint->>'end')::numeric DESC LIMIT 1),
 replay AS (SELECT checkpoint FROM source WHERE (checkpoint->>'start')::numeric=$4 AND (checkpoint->>'end')::numeric=$5 LIMIT 1)
 SELECT checkpoint FROM latest UNION SELECT checkpoint FROM replay`, branch, source, generation, record.Start, record.End)
	if err != nil {
		return nil, false, err
	}
	var previous json.RawMessage
	var latest uint64
	var replay *transcriptCheckpoint
	for rows.Next() {
		var raw []byte
		var checkpoint transcriptCheckpoint
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal(raw, &checkpoint); err != nil {
			break
		}
		if checkpoint.End > latest {
			latest = checkpoint.End
			previous = checkpoint.State
		}
		if checkpoint.Start == record.Start && checkpoint.End == record.End {
			if checkpoint.Hash != hash {
				err = chat.ErrConflict
				break
			}
			copy := checkpoint
			replay = &copy
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, false, err
	}
	checkpoint := transcriptCheckpoint{Source: source, Generation: generation, Start: record.Start, End: record.End, Hash: hash,
		Session: record.Session, Participant: uuid.UUID(record.Participant).String(), Profile: record.Profile, Owner: binding.Scope.UserID, Boot: binding.Boot}
	var drafts []chat.ExternalDraft
	if replay != nil {
		checkpoint.State = replay.State
	} else {
		// A stopped generation imports nothing more. The entry that says so
		// was committed with the record that stopped it, exactly once.
		var stopped bool
		err = tx.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM machine_event_receipts
 WHERE workspace_id=$1 AND transcript_checkpoint->>'source'=$2 AND transcript_checkpoint->>'generation'=$3
 AND transcript_checkpoint->>'stopped' IS NOT NULL AND outcome='rejected')`, branch, source, generation).Scan(&stopped)
		if err != nil {
			return nil, false, err
		}
		if stopped {
			return nil, true, nil
		}
		// Write holds the workspace row lock, so generation retirement and
		// checkpoint advancement serialize across connections. Existing ranges
		// above remain replayable after replacement; new data cannot advance a
		// retired generation or resurrect one with no committed checkpoint.
		var retired bool
		err = tx.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM machine_event_receipts
 WHERE workspace_id=$1 AND transcript_checkpoint->>'source'=$2
 AND (transcript_checkpoint->>'generation')::numeric > $3::numeric
 AND outcome='applied')`, branch, source, generation).Scan(&retired)
		if err != nil {
			return nil, false, err
		}
		if retired {
			return nil, false, chat.ErrCursorConflict
		}
		if record.Start != latest {
			return nil, false, chat.ErrCursorConflict
		}
		participant := uuid.UUID(record.Participant).String()
		decoded, err := s.Host.NormalizeExternalTranscript(ctx, chat.ExternalNormalizeInput{Profile: record.Profile, Context: map[string]string{"owner_id": fmt.Sprint(binding.Scope.UserID), "participant_id": participant, "session_id": fmt.Sprint(record.Session), "source_generation": source + ":" + generation}, Record: record.Record, Skipped: record.Skipped, Start: record.Start, End: record.End, State: previous})
		var refusal *chat.ExternalRefusal
		switch {
		case errors.As(err, &refusal):
			// The adapter does not read this release or this kind of record.
			// Say so in the conversation, once, and stop the generation here:
			// its state does not advance and nothing after it is guessed.
			body, err := json.Marshal(map[string]string{"type": "error", "message": refusal.Sentence()})
			if err != nil {
				return nil, false, err
			}
			agent := "claude-code"
			if strings.HasPrefix(record.Profile, "codex") {
				agent = "codex"
			}
			drafts = []chat.ExternalDraft{{
				ID: source + ":" + generation + ":stopped", SourceID: fmt.Sprintf("%s:%d", source, refusal.Line), SourceOffset: record.Start,
				Origin: "external", ReadOnly: true, Agent: agent, Profile: record.Profile, Session: fmt.Sprint(record.Session),
				Participant: participant, Owner: fmt.Sprint(binding.Scope.UserID), Author: participant, Kind: "error", Body: body, Failed: true,
			}}
			checkpoint.State, checkpoint.Stopped = previous, refusal.Reason
		case err != nil:
			return nil, false, err
		default:
			var state struct {
				Offset  uint64 `json:"offset"`
				Pending string `json:"pending"`
			}
			if json.Unmarshal(decoded.State, &state) != nil || state.Offset != record.End || state.Pending != "" || decoded.NeedsMore {
				return nil, false, chat.ErrInvalidFrame
			}
			drafts = decoded.Entries
			checkpoint.State = decoded.State
		}
	}
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		return nil, false, err
	}
	result, err := tx.Exec(ctx, `UPDATE machine_event_receipts SET transcript_checkpoint=$3 WHERE workspace_id=$1 AND event_id=$2 AND outcome='pending'`, branch, uuid.UUID(eventID).String(), encoded)
	if err != nil {
		return nil, false, err
	}
	if result.RowsAffected() != 1 {
		return nil, false, errors.New("transcript checkpoint requires pending receipt")
	}
	return drafts, checkpoint.Stopped != "", nil
}
