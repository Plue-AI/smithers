package machined

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BurstObjects verifies the parentless versions commit, its a/ and b/ paths,
// blob identities and post SHA-256s in the branch's host store. Missing objects
// must be reported before any durable receipt is written. Publishing retains
// the verified commit at the host-selected burst ref before acknowledgement.
type BurstObjects interface {
	VerifyBurst(context.Context, string, wire.Burst) ([]string, error)
	PublishBurst(context.Context, string, string, string) error
}

// BurstIngest is the sole transactional projection of an authenticated event.
// Scope and attribution are host-resolved; no guest principal names a member.
type BurstIngest struct {
	Pool         *pgxpool.Pool
	Objects      BurstObjects
	ResolveActor func(context.Context, string, wire.Actor) (json.RawMessage, error)
}

func validBurstPath(p string) bool {
	return p != "" && p != "." && len(p) <= 4096 && !strings.ContainsAny(p, "\x00\\") && !strings.HasPrefix(p, "/") && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") && p != ".git" && !strings.HasPrefix(p, ".git/") && p != ".jj" && !strings.HasPrefix(p, ".jj/")
}

// Apply is called by the W3 event pump; it returns an ack only after commit
// and ref retention. A failed ack transport is repaired by outbox replay.
func (s *BurstIngest) Apply(ctx context.Context, connection *Connection, scope jobs.Scope, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if s == nil || s.Pool == nil || s.Objects == nil || s.ResolveActor == nil || connection == nil {
		return ack, ErrNotReady
	}
	if event.Seq == 0 || event.EventID == ([16]byte{}) {
		return ack, wire.BadValue
	}
	b, err := wire.DecodeBurst(event.Payload)
	if err != nil {
		return ack, err
	}
	if b.ID == ([16]byte{}) || len(b.Files) == 0 {
		return ack, wire.BadValue
	}
	// Split bursts require a complete object/event assembly from the transport.
	// Never acknowledge a partial entry as the full burst.
	if b.Part != 0 || b.Parts != 0 {
		return ack, ErrNotReady
	}
	seen := map[string]bool{}
	for _, f := range b.Files {
		if !validBurstPath(f.Path) || (f.RenamedTo != "" && !validBurstPath(f.RenamedTo)) || seen[f.Path] || (f.AfterBlob != "" && f.PostDigest == "") {
			return ack, wire.BadValue
		}
		seen[f.Path] = true
	}
	r := connection.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if !connection.current() {
		return ack, ErrUnauthorized
	}
	branch := connection.boot.branch
	actor, err := s.ResolveActor(ctx, branch, b.Actor)
	if err != nil {
		return ack, err
	}
	if !json.Valid(actor) {
		return ack, ErrUnauthorized
	}
	missing, err := s.Objects.VerifyBurst(ctx, branch, b)
	if err != nil {
		return ack, err
	}
	if len(missing) != 0 {
		ack.Outcome, ack.OIDs = AckMissingObjects, missing
		return ack, nil
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ack, err
	}
	defer tx.Rollback(ctx)
	// The stream scope is derived from the host workspace, not the event or
	// caller. This prevents an authenticated connection crossing repositories.
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	if scope.TenantID != fmt.Sprint(repository) || scope.PrincipalID != "branch:"+branch {
		return ack, ErrUnauthorized
	}
	id := uuid.UUID(event.EventID).String()
	burstID := uuid.UUID(b.ID).String()
	// Serialize this branch on its authoritative workspace row. Receipts
	// retain the transport event ID and the logical burst identity even when
	// activity retention has pruned the original event.
	outcome := fmt.Sprintf("applied:%s:%x", burstID, sha256.Sum256(event.Payload))
	var previous string
	err = tx.QueryRow(ctx, `SELECT outcome FROM machine_event_receipts WHERE workspace_id=$1 AND (event_id=$2 OR outcome LIKE $3) LIMIT 1`, branch, id, "applied:"+burstID+":%").Scan(&previous)
	duplicate := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ack, err
	}
	if duplicate && previous != outcome {
		return ack, wire.BadValue
	}
	if _, err = tx.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, branch, id, outcome); err != nil {
		return ack, err
	}
	if !duplicate {
		data, marshalErr := json.Marshal(map[string]any{"id": burstID, "kind": "burst", "branch": branch, "actor": json.RawMessage(actor), "files": b.Files, "versions": b.Versions, "source_key": burstID, "machine_event_id": id})
		if marshalErr != nil {
			return ack, marshalErr
		}
		fact, appendErr := jobs.RecordFactInTx(ctx, tx, scope, uuid.NewString(), "branch.burst", "completed", data)
		if appendErr != nil {
			return ack, appendErr
		}
		for _, f := range b.Files {
			_, err = tx.Exec(ctx, `INSERT INTO burst_files(event_id,path,change,before_blob,after_blob,post_digest,renamed_to) VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''))`, fact.EventID, f.Path, f.Change, f.BeforeBlob, f.AfterBlob, f.PostDigest, f.RenamedTo)
			if err != nil {
				return ack, err
			}
		}
		// Both live projections rebuild from committed facts; NOTIFY cannot
		// escape rollback and uses the existing shared LISTEN broker.
		for _, topic := range []string{"activity", "files"} {
			if _, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_"+topic); err != nil {
				return ack, err
			}
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return ack, err
	}
	// A publish failure deliberately leaves the receipt: replay retries ref
	// retention, without appending another activity entry.
	if err = s.Objects.PublishBurst(ctx, branch, burstID, b.Versions); err != nil {
		return ack, err
	}
	ack.Outcome = AckApplied
	if duplicate {
		ack.Outcome = AckDuplicate
	}
	return ack, nil
}

// DispatchBurst binds the commit and its acknowledgement to the same admitted
// link. A boot change can never redirect an old event's ack to a new daemon.
func (s *BurstIngest) DispatchBurst(ctx context.Context, link *Link, scope jobs.Scope, event Event) error {
	if link == nil {
		return ErrNotReady
	}
	ack, err := s.Apply(ctx, link.Connection, scope, event)
	if err != nil {
		return err
	}
	return link.Ack(ctx, link.boot.branch, ack)
}
