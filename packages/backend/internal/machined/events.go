package machined

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"path"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// BurstObjects is the host store after the authenticated object stream closes.
// Verify checks types, exact versions-tree membership and content digests.
type BurstObjects interface {
	Verify(context.Context, string, wire.Burst) ([]string, error)
	Retain(context.Context, string, wire.Burst) error
}

// BurstActors resolves only host-registered participants; ids grant no rights.
type BurstActors interface {
	ResolveBurstActor(context.Context, string, wire.Actor) (json.RawMessage, error)
}

// Events consumes the existing daemon connection and event writer. Isolation
// is an image activation precondition, never inferred from a guest message.
type Events struct {
	Pool     *pgxpool.Pool
	Objects  BurstObjects
	Actors   BurstActors
	Isolated bool
	Scope    jobs.Scope // host item operation stream, not supplied by the daemon
}

func validBurstPath(p string) bool {
	return p != "" && p != "." && path.Clean(p) == p && !strings.HasPrefix(p, "/") && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsRune(p, 0) && p != ".git" && !strings.HasPrefix(p, ".git/") && p != ".jj" && !strings.HasPrefix(p, ".jj/")
}
func validateBurst(b wire.Burst) error {
	if (b.Part == 0) != (b.Parts == 0) || b.Part > b.Parts {
		return wire.BadValue
	}
	// The transport must assemble bounded parts before a whole burst commits.
	// Never acknowledge a partial entry as the complete durable change.
	if b.Parts > 1 {
		return ErrNotReady
	}
	if b.Sequence == 0 || b.Sequence > math.MaxInt64 || b.ID == ([16]byte{}) || b.EventID == ([16]byte{}) || len(b.Files) == 0 {
		return wire.BadValue
	}
	seen := map[string]bool{}
	for _, f := range b.Files {
		if !validBurstPath(f.Path) || seen[f.Path] || f.RenamedTo != "" && !validBurstPath(f.RenamedTo) {
			return wire.BadValue
		}
		seen[f.Path] = true
		switch f.Change {
		case "added":
			if f.BeforeBlob != "" || f.AfterBlob == "" {
				return wire.BadValue
			}
		case "modified", "renamed":
			if f.BeforeBlob == "" || f.AfterBlob == "" {
				return wire.BadValue
			}
		case "deleted":
			if f.BeforeBlob == "" || f.AfterBlob != "" {
				return wire.BadValue
			}
		default:
			return wire.BadValue
		}
		if (f.Change == "renamed") != (f.RenamedTo != "") || (f.AfterBlob != "") != (f.PostDigest != "") {
			return wire.BadValue
		}
	}
	return nil
}

// Ingest returns an ack to the existing event dispatcher, never writes one
// itself. Commit precedes both success ack and transaction-delivered hints.
func (e *Events) Ingest(ctx context.Context, c *Connection, branch string, frame wire.Frame) (wire.Frame, error) {
	if e == nil || e.Pool == nil || e.Objects == nil || e.Actors == nil || !e.Isolated {
		return wire.Frame{}, ErrNotReady
	}
	if c == nil || c.registry == nil || c.boot == nil {
		return wire.Frame{}, ErrUnauthorized
	}
	if err := c.RequireReady(branch); err != nil {
		return wire.Frame{}, err
	}
	b, err := frame.BurstEvent()
	if err != nil {
		return wire.Frame{}, err
	}
	if err = validateBurst(b); err != nil {
		return wire.Frame{}, err
	}
	missing, err := e.Objects.Verify(ctx, branch, b)
	if err != nil {
		return wire.Frame{}, err
	}
	if len(missing) > 0 {
		return wire.BurstAck(b.Sequence, 3, missing)
	}
	actor, err := e.Actors.ResolveBurstActor(ctx, branch, b.Actor)
	if err != nil {
		return wire.Frame{}, err
	}
	if !json.Valid(actor) || len(actor) == 0 || actor[0] != '{' {
		return wire.Frame{}, ErrUnauthorized
	}
	data, err := json.Marshal(struct {
		Actor     json.RawMessage  `json:"actor"`
		BurstID   string           `json:"burst_id"`
		SourceKey string           `json:"source_key"`
		Branch    string           `json:"branch_id"`
		Versions  string           `json:"versions_commit"`
		Files     []wire.BurstFile `json:"files"`
	}{actor, uuid.UUID(b.ID).String(), uuid.UUID(b.ID).String(), branch, b.VersionsCommit, b.Files})
	if err != nil {
		return wire.Frame{}, err
	}
	tx, err := e.Pool.Begin(ctx)
	if err != nil {
		return wire.Frame{}, err
	}
	defer tx.Rollback(ctx)
	// Serialize burst redelivery even when it arrives under another event id.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, branch); err != nil {
		return wire.Frame{}, err
	}
	var inserted string
	err = tx.QueryRow(ctx, `INSERT INTO machine_event_receipts(branch_id,event_id,seq) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id::text`, branch, uuid.UUID(b.EventID).String(), int64(b.Sequence)).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		var sequence int64
		if err = tx.QueryRow(ctx, `SELECT seq FROM machine_event_receipts WHERE branch_id=$1 AND event_id=$2`, branch, uuid.UUID(b.EventID).String()).Scan(&sequence); err != nil {
			return wire.Frame{}, err
		}
		if sequence != int64(b.Sequence) {
			return wire.Frame{}, wire.BadValue
		}
		operation := uuid.NewSHA1(uuid.NameSpaceOID, []byte(branch+":"+uuid.UUID(b.ID).String())).String()
		var same bool
		if err = tx.QueryRow(ctx, `SELECT payload=$2::jsonb FROM product_job_requests WHERE id=$1`, operation, data).Scan(&same); err != nil || !same {
			return wire.Frame{}, wire.BadValue
		}
		return wire.BurstAck(b.Sequence, 2, nil)
	}
	if err != nil {
		return wire.Frame{}, err
	}
	operation := uuid.NewSHA1(uuid.NameSpaceOID, []byte(branch+":"+uuid.UUID(b.ID).String())).String()
	var same bool
	err = tx.QueryRow(ctx, `SELECT payload=$2::jsonb FROM product_job_requests WHERE id=$1`, operation, data).Scan(&same)
	duplicate := err == nil
	if duplicate && !same {
		return wire.Frame{}, wire.BadValue
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return wire.Frame{}, err
	}
	if !duplicate {
		if _, err = jobs.RecordFactInTx(ctx, tx, e.Scope, operation, "branch.changed", "completed", data); err != nil {
			return wire.Frame{}, err
		}
		for _, f := range b.Files {
			if _, err = tx.Exec(ctx, `INSERT INTO burst_files(branch_id,burst_id,path,change,renamed_to,before_blob,after_blob,after_digest) VALUES($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''))`, branch, uuid.UUID(b.ID).String(), f.Path, f.Change, f.RenamedTo, f.BeforeBlob, f.AfterBlob, f.PostDigest); err != nil {
				return wire.Frame{}, err
			}
		}
		if err = e.Objects.Retain(ctx, branch, b); err != nil {
			return wire.Frame{}, err
		}
		for _, topic := range []string{"activity", "files"} {
			if _, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_"+topic); err != nil {
				return wire.Frame{}, err
			}
		}
	}
	// Fence boot replacement through the commit. No network send under this lock.
	c.registry.mu.Lock()
	if !c.current() || !c.ready {
		c.registry.mu.Unlock()
		return wire.Frame{}, ErrUnauthorized
	}
	err = tx.Commit(ctx)
	c.registry.mu.Unlock()
	if err != nil {
		return wire.Frame{}, err
	}
	outcome := byte(1)
	if duplicate {
		outcome = 2
	}
	return wire.BurstAck(b.Sequence, outcome, nil)
}
