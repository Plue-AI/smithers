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
}

func (s *TranscriptIngest) normalizeHost(ctx context.Context, tx pgx.Tx, branch string, binding TranscriptBinding, record wire.Transcript, eventID [16]byte) ([]chat.ExternalDraft, error) {
	// The adapters use JS numbers for byte offsets. Reject unrepresentable
	// offsets before sending any record rather than rounding its source identity.
	if record.End > 9007199254740991 {
		return nil, wire.BadValue
	}
	source := uuid.UUID(record.Source).String()
	generation := fmt.Sprint(record.Generation)
	canonical, err := wire.EncodeTranscript(record)
	if err != nil {
		return nil, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(canonical))
	rows, err := tx.Query(ctx, `WITH source AS (
 SELECT transcript_checkpoint AS checkpoint FROM machine_event_receipts
 WHERE workspace_id=$1 AND transcript_checkpoint->>'source'=$2 AND transcript_checkpoint->>'generation'=$3 AND outcome IN ('applied','pending')
 ), latest AS (SELECT checkpoint FROM source ORDER BY (checkpoint->>'end')::numeric DESC LIMIT 1),
 replay AS (SELECT checkpoint FROM source WHERE (checkpoint->>'start')::numeric=$4 AND (checkpoint->>'end')::numeric=$5 LIMIT 1)
 SELECT checkpoint FROM latest UNION SELECT checkpoint FROM replay`, branch, source, generation, record.Start, record.End)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	checkpoint := transcriptCheckpoint{Source: source, Generation: generation, Start: record.Start, End: record.End, Hash: hash}
	var drafts []chat.ExternalDraft
	if replay != nil {
		checkpoint.State = replay.State
	} else {
		if record.Start != latest {
			return nil, chat.ErrCursorConflict
		}
		decoded, err := s.Host.NormalizeExternalTranscript(ctx, chat.ExternalNormalizeInput{Profile: record.Profile, Context: map[string]string{"owner_id": fmt.Sprint(binding.Scope.UserID), "participant_id": uuid.UUID(record.Participant).String(), "session_id": fmt.Sprint(record.Session), "source_generation": source + ":" + generation}, Record: record.Record, Start: record.Start, End: record.End, State: previous})
		if err != nil {
			return nil, err
		}
		var state struct {
			Offset  uint64 `json:"offset"`
			Pending string `json:"pending"`
		}
		if json.Unmarshal(decoded.State, &state) != nil || state.Offset != record.End || state.Pending != "" || decoded.NeedsMore {
			return nil, chat.ErrInvalidFrame
		}
		drafts = decoded.Entries
		checkpoint.State = decoded.State
	}
	encoded, err := json.Marshal(checkpoint)
	if err != nil {
		return nil, err
	}
	result, err := tx.Exec(ctx, `UPDATE machine_event_receipts SET transcript_checkpoint=$3 WHERE workspace_id=$1 AND event_id=$2 AND outcome='pending'`, branch, uuid.UUID(eventID).String(), encoded)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, errors.New("transcript checkpoint requires pending receipt")
	}
	return drafts, nil
}
