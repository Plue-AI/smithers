package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// installTranscripts is the install's transcript import: the shared chat
// journal and the packaged host's pure adapters. It returns nil when the chat
// host cannot normalize transcripts, and the event pump then refuses every
// transcript record as unavailable before it reads or stores anything.
func installTranscripts(pool *pgxpool.Pool, host ports.ChatHost) (*TranscriptIngest, error) {
	adapter, ok := host.(transcriptAdapter)
	if !ok || pool == nil {
		return nil, nil
	}
	store, err := chat.NewStore(pool)
	if err != nil {
		return nil, err
	}
	return &TranscriptIngest{Store: store, Host: adapter}, nil
}

// How long a record waits for its session's receipt, and how often it looks.
const (
	sessionReceiptWait = 2 * time.Second
	sessionReceiptPoll = 100 * time.Millisecond
)

// awaitTranscriptSession waits, at most sessionReceiptWait, for the receipt of
// the session a transcript record names. The host writes that receipt when it
// opens the session, before a member can have started an agent in it, so a
// record that arrives first is at most a moment early.
//
// It runs before the writer takes any lock. It decides nothing: whether the
// receipt came or not, the writer reads it again and answers. A record that
// does not decode, or a link with no boot yet, has nothing to wait for.
func awaitTranscriptSession(ctx context.Context, tx pgx.Tx, branch string, link *machined.Link, event machined.Event) error {
	record, err := wire.DecodeTranscript(event.Payload)
	boot := link.BootID()
	if err != nil || boot == ([16]byte{}) {
		return nil
	}
	for waited := time.Duration(0); ; waited += sessionReceiptPoll {
		var opened bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3)`,
			"branch:"+branch, hex.EncodeToString(boot[:]), strconv.FormatUint(uint64(record.Session), 10)).Scan(&opened); err != nil {
			return err
		}
		if opened || waited >= sessionReceiptWait {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sessionReceiptPoll):
		}
	}
}

// installTranscriptSource answers who a transcript record belongs to from two
// facts the host wrote itself: the receipt of the terminal session it opened on
// this machine boot (machineHost.Record), and the registration the source's
// earlier records committed under. The daemon supplies only numbers to look up.
//
// A session the host has no receipt for has no answer here; the event pump
// has already waited a moment for the receipt (awaitTranscriptSession) and
// settles what is still unanswered as refused. A session that is not a
// member's own, or a record whose source was registered for another session,
// participant, profile, owner or boot, is refused for good.
func installTranscriptSource(link *machined.Link) func(context.Context, pgx.Tx, string, wire.Transcript) (TranscriptBinding, error) {
	return func(ctx context.Context, tx pgx.Tx, branch string, record wire.Transcript) (TranscriptBinding, error) {
		boot := link.BootID()
		if boot == ([16]byte{}) {
			return TranscriptBinding{}, machined.ErrNotReady
		}
		bootID := hex.EncodeToString(boot[:])
		var member int64
		var login, via string
		err := tx.QueryRow(ctx, `SELECT COALESCE((data->>'member_id')::bigint,0),COALESCE(data->>'login',''),COALESCE(data->>'via','terminal')
 FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3`,
			"branch:"+branch, bootID, strconv.FormatUint(uint64(record.Session), 10)).Scan(&member, &login, &via)
		if errors.Is(err, pgx.ErrNoRows) {
			return TranscriptBinding{}, machined.ErrNotReady
		}
		if err != nil {
			return TranscriptBinding{}, err
		}
		// A person runs their own Claude Code or Codex in their own terminal.
		// A coding run's session belongs to the factory; its agent is not a
		// member's external agent and its transcript is not imported here.
		if member <= 0 || login == "agent" || strings.HasPrefix(via, "agent:") {
			return TranscriptBinding{}, machined.ErrUnauthorized
		}
		var repository int64
		var owner string
		err = tx.QueryRow(ctx, `SELECT w.repository_id,u.username FROM workspaces w, users u WHERE w.id=$1 AND u.id=$2`, branch, member).Scan(&repository, &owner)
		if errors.Is(err, pgx.ErrNoRows) {
			return TranscriptBinding{}, machined.ErrUnauthorized
		}
		if err != nil {
			return TranscriptBinding{}, err
		}
		binding := TranscriptBinding{Scope: chat.Scope{RepositoryID: repository, UserID: member, Owner: owner},
			Session: record.Session, Participant: record.Participant, Source: record.Source, Profile: record.Profile, Boot: bootID, Live: true}
		var pinned []byte
		err = tx.QueryRow(ctx, `SELECT transcript_checkpoint FROM machine_event_receipts
 WHERE workspace_id=$1 AND transcript_checkpoint->>'source'=$2 ORDER BY at LIMIT 1`, branch, uuid.UUID(record.Source).String()).Scan(&pinned)
		if errors.Is(err, pgx.ErrNoRows) {
			// The source's first record: what it names is what it is from now on.
			return binding, nil
		}
		if err != nil {
			return TranscriptBinding{}, err
		}
		var pin transcriptCheckpoint
		if err = json.Unmarshal(pinned, &pin); err != nil {
			return TranscriptBinding{}, err
		}
		if pin.Boot != bootID || pin.Session != record.Session || pin.Participant != uuid.UUID(record.Participant).String() || pin.Profile != record.Profile || pin.Owner != member {
			return TranscriptBinding{}, machined.ErrUnauthorized
		}
		return binding, nil
	}
}
