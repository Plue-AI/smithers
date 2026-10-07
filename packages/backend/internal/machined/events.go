package machined

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"reflect"
	"strconv"
	"strings"
	"time"

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

// BurstStore holds repository maintenance exclusion while the event uses its
// existing database transaction. Providers must not borrow a second connection.
type BurstStore interface {
	WithBurstObjects(context.Context, pgx.Tx, string, func(BurstObjects) error) error
}

// BurstIngest is the sole transactional projection of an authenticated event.
// Scope and attribution are host-resolved; no guest principal names a member.
type BurstIngest struct {
	Pool    *pgxpool.Pool
	Objects BurstStore
	// ResolveActor is an optional legacy migration adapter. It must use retained
	// historical authority, never current presence, roster or run checkpoints.
	// The installed consumer leaves it nil: ambiguous session/run identifiers
	// cannot establish an earlier author. Exact committed unchunked replays are
	// acknowledged from their immutable receipt without resolving a new author.
	// Split bursts use the historical identity retained with their staged parts.
	// Principal references always resolve in the event transaction instead.
	ResolveActor func(context.Context, string, wire.Actor) (json.RawMessage, error)
	// ObserveCommitted records one successfully committed logical burst, never
	// staging, duplicates or refusals. It runs under the connection fence and
	// must not call back into the registry.
	ObserveCommitted func()
}

func validBurstPath(p string) bool {
	return p != "" && p != "." && len(p) <= 4096 && !strings.ContainsAny(p, "\x00\\") && !strings.HasPrefix(p, "/") && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") && p != ".git" && !strings.HasPrefix(p, ".git/") && p != ".jj" && !strings.HasPrefix(p, ".jj/")
}

// Apply is called by the W3 event pump; it returns an ack only after commit
// and ref retention for complete bursts, or durable staging for split parts.
// A failed ack transport is repaired by outbox replay.
func (s *BurstIngest) Apply(ctx context.Context, connection *Connection, scope jobs.Scope, event Event) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	if s == nil || s.Pool == nil || s.Objects == nil || connection == nil {
		return ack, ErrNotReady
	}
	if connection.registry == nil || connection.boot == nil {
		return ack, ErrUnauthorized
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
	if (b.Part == 0) != (b.Parts == 0) || b.Part > b.Parts || b.Parts == 1 || b.Parts > 4096 {
		return ack, wire.BadValue
	}
	seen := map[string]bool{}
	for _, f := range b.Files {
		if !validBurstPath(f.Path) || (f.RenamedTo != "" && !validBurstPath(f.RenamedTo)) || seen[f.Path] || (f.AfterBlob != "" && f.PostDigest == "") {
			return ack, wire.BadValue
		}
		seen[f.Path] = true
	}
	r := connection.registry
	if r == nil || connection.boot == nil {
		return ack, ErrUnauthorized
	}
	r.mu.Lock()
	current := connection.current()
	branch := connection.boot.branch
	r.mu.Unlock()
	if !current {
		return ack, ErrUnauthorized
	}
	// A legacy migration provider may read storage. Resolve outside the
	// registry lock, then fence the same connection before persistent effects.
	legacyReplay := (b.Actor.Kind == 2 || b.Actor.Kind == 3) && s.ResolveActor == nil
	var actor json.RawMessage
	if !legacyReplay {
		actor, err = s.resolveLegacyActor(ctx, branch, b.Actor)
	}
	if err != nil {
		return ack, err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return ack, err
	}
	defer rollbackActorEvent(ctx, tx)
	if legacyReplay && b.Parts != 0 {
		actor, err = retainedLegacyBurstActor(ctx, tx, branch, b)
		if err != nil {
			return ack, err
		}
	}
	if actor == nil && !legacyReplay {
		actor, err = resolveStoredEventActor(ctx, tx, branch, connection.boot.machine, b.Actor)
		if err != nil {
			return ack, err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !connection.current() {
		return ack, ErrUnauthorized
	}
	// The stream scope is derived from the host workspace, not the event or
	// caller. This prevents an authenticated connection crossing repositories.
	var repository int64
	if err = tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1 FOR UPDATE`, branch).Scan(&repository); err != nil {
		return ack, err
	}
	if scope.TenantID != fmt.Sprint(repository) || scope.PrincipalID != "branch:"+branch {
		return ack, ErrUnauthorized
	}
	if legacyReplay && b.Parts == 0 {
		// Only a complete, byte-identical receipt proves this old event was
		// already accepted. No author is inferred and no new activity is made.
		if err = requireLegacyBurstReceipt(ctx, tx, branch, event, b); err != nil {
			return ack, err
		}
	}
	multipart := b.Parts != 0
	if multipart {
		complete, assembled, stageErr := stageBurst(ctx, tx, branch, event, b, actor)
		if stageErr != nil {
			return ack, stageErr
		}
		if !complete {
			if err = tx.Commit(ctx); err != nil {
				return ack, err
			}
			// Applied acknowledges durable staging, not a projected activity entry.
			// The outbox can advance to the next part after a host restart.
			ack.Outcome = AckApplied
			return ack, nil
		}
		b = assembled
		seen = map[string]bool{}
		for _, f := range b.Files {
			if seen[f.Path] {
				return ack, wire.BadValue
			}
			seen[f.Path] = true
		}
	}
	err = s.Objects.WithBurstObjects(ctx, tx, branch, func(objects BurstObjects) error {
		if objects == nil {
			return ErrNotReady
		}
		var applyErr error
		ack, applyErr = commitBurst(ctx, tx, objects, branch, scope, event, b, actor, multipart)
		return applyErr
	})
	if err == nil && ack.Outcome == AckApplied && s.ObserveCommitted != nil {
		s.ObserveCommitted()
	}
	return ack, err
}

func commitBurst(ctx context.Context, tx pgx.Tx, objects BurstObjects, branch string, scope jobs.Scope, event Event, b wire.Burst, actor json.RawMessage, multipart bool) (Acknowledgement, error) {
	ack := Acknowledgement{Seq: event.Seq}
	missing, err := objects.VerifyBurst(ctx, branch, b)
	if err != nil {
		return ack, err
	}
	if len(missing) != 0 {
		ack.Outcome, ack.OIDs = AckMissingObjects, missing
		return ack, nil
	}
	id := uuid.UUID(event.EventID).String()
	burstID := uuid.UUID(b.ID).String()
	// Serialize this branch on its authoritative workspace row. Receipts
	// retain the transport event ID and the logical burst identity even when
	// activity retention has pruned the original event.
	canonical := event.Payload
	if multipart {
		canonical, err = json.Marshal(b)
		if err != nil {
			return ack, err
		}
	}
	outcome := fmt.Sprintf("applied:%s:%x", burstID, sha256.Sum256(canonical))
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
		if actor == nil {
			return ack, ErrHistoricalActorUnavailable
		}
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
	// Retain the verified snapshot before exposing its activity or notifying
	// readers. A ref failure rolls back every row and receipt. If SQL commit
	// fails after retention, the immutable ref safely survives and replay
	// retries the transaction against the same pinned bytes.
	if err = objects.PublishBurst(ctx, branch, burstID, b.Versions); err != nil {
		return ack, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ack, err
	}
	ack.Outcome = AckApplied
	if duplicate {
		ack.Outcome = AckDuplicate
	}
	return ack, nil
}

// ErrHistoricalActorUnavailable is a recovery refusal. Old wire records remain
// decodable, but today's sessions cannot prove who produced their earlier bytes.
var ErrHistoricalActorUnavailable = fmt.Errorf("%w: historical machine actor unavailable", ErrNotReady)

func requireLegacyBurstReceipt(ctx context.Context, tx pgx.Tx, branch string, event Event, b wire.Burst) error {
	if b.Parts != 0 {
		return ErrHistoricalActorUnavailable
	}
	var previous string
	err := tx.QueryRow(ctx, `SELECT outcome FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, uuid.UUID(event.EventID).String()).Scan(&previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrHistoricalActorUnavailable
	}
	if err != nil {
		return err
	}
	want := fmt.Sprintf("applied:%s:%x", uuid.UUID(b.ID).String(), sha256.Sum256(event.Payload))
	if previous != want {
		return wire.BadValue
	}
	return nil
}

type burstStage struct {
	Payload []byte
	Actor   json.RawMessage
}

// A durably staged part binds the whole logical burst's author, actor envelope,
// part count and immutable versions. That is historical authority for the other
// parts of that same burst, not permission to reuse a session for a new burst.
func retainedLegacyBurstActor(ctx context.Context, tx pgx.Tx, branch string, incoming wire.Burst) (json.RawMessage, error) {
	prefix := "staged:" + uuid.UUID(incoming.ID).String() + ":"
	var outcome string
	err := tx.QueryRow(ctx, `SELECT outcome FROM machine_event_receipts WHERE workspace_id=$1 AND outcome LIKE $2 ORDER BY event_id LIMIT 1`, branch, prefix+"%").Scan(&outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrHistoricalActorUnavailable
	}
	if err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(outcome, prefix))
	if err != nil {
		return nil, wire.BadValue
	}
	var stage burstStage
	if json.Unmarshal(raw, &stage) != nil || !json.Valid(stage.Actor) || string(stage.Actor) == "null" {
		return nil, wire.BadValue
	}
	part, err := wire.DecodeBurst(stage.Payload)
	if err != nil || part.ID != incoming.ID || part.Parts != incoming.Parts || part.Versions != incoming.Versions || !reflect.DeepEqual(part.Actor, incoming.Actor) || part.Part == 0 || part.Part > part.Parts {
		return nil, wire.BadValue
	}
	return stage.Actor, nil
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

// stageBurst uses the existing durable receipt store. Intermediate receipts
// contain the exact codec payload; no partial activity or files are published.
// The workspace row lock serializes assembly across connections and restarts.
func stageBurst(ctx context.Context, tx pgx.Tx, branch string, event Event, incoming wire.Burst, actor json.RawMessage) (bool, wire.Burst, error) {
	prefix := "staged:" + uuid.UUID(incoming.ID).String() + ":"
	rows, err := tx.Query(ctx, `SELECT event_id::text,outcome FROM machine_event_receipts WHERE workspace_id=$1 AND outcome LIKE $2`, branch, prefix+"%")
	if err != nil {
		return false, incoming, err
	}
	parts := map[uint16]wire.Burst{}
	total := 0
	for rows.Next() {
		var id, outcome string
		if err = rows.Scan(&id, &outcome); err != nil {
			rows.Close()
			return false, incoming, err
		}
		stored, decodeErr := base64.StdEncoding.DecodeString(strings.TrimPrefix(outcome, prefix))
		if decodeErr != nil {
			rows.Close()
			return false, incoming, wire.BadValue
		}
		var stage burstStage
		if json.Unmarshal(stored, &stage) != nil {
			rows.Close()
			return false, incoming, wire.BadValue
		}
		var oldActor, newActor any
		if json.Unmarshal(stage.Actor, &oldActor) != nil || json.Unmarshal(actor, &newActor) != nil || !reflect.DeepEqual(oldActor, newActor) {
			rows.Close()
			return false, incoming, ErrUnauthorized
		}
		payload := stage.Payload
		part, decodeErr := wire.DecodeBurst(payload)
		if decodeErr != nil || part.ID != incoming.ID || part.Parts != incoming.Parts || part.Versions != incoming.Versions || !reflect.DeepEqual(part.Actor, incoming.Actor) || part.Part == 0 || part.Part > part.Parts {
			rows.Close()
			return false, incoming, wire.BadValue
		}
		if old, exists := parts[part.Part]; exists && !reflect.DeepEqual(old, part) {
			rows.Close()
			return false, incoming, wire.BadValue
		}
		parts[part.Part] = part
		total += len(payload)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, incoming, err
	}
	if old, exists := parts[incoming.Part]; exists && !reflect.DeepEqual(old, incoming) {
		return false, incoming, wire.BadValue
	}
	parts[incoming.Part] = incoming
	total += len(event.Payload)
	if total > 32<<20 {
		return false, incoming, wire.BadValue
	}
	id := uuid.UUID(event.EventID).String()
	stored, err := json.Marshal(burstStage{event.Payload, actor})
	if err != nil {
		return false, incoming, err
	}
	outcome := prefix + base64.StdEncoding.EncodeToString(stored)
	var previous string
	err = tx.QueryRow(ctx, `SELECT outcome FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2`, branch, id).Scan(&previous)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, incoming, err
	}
	if err == nil && previous != outcome && !strings.HasPrefix(previous, "applied:"+uuid.UUID(incoming.ID).String()+":") {
		return false, incoming, wire.BadValue
	}
	if len(parts) != int(incoming.Parts) {
		if err == nil && strings.HasPrefix(previous, "applied:") {
			return false, incoming, wire.BadValue
		}
		_, err = tx.Exec(ctx, `INSERT INTO machine_event_receipts(workspace_id,event_id,outcome) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, branch, id, outcome)
		return false, incoming, err
	}
	assembled := incoming
	assembled.Part, assembled.Parts = 0, 0
	assembled.Files = nil
	for i := uint16(1); i <= incoming.Parts; i++ {
		assembled.Files = append(assembled.Files, parts[i].Files...)
		if len(assembled.Files) > 65535 {
			return false, incoming, wire.BadValue
		}
	}
	// Replace only this transport event's staging receipt with the atomic final
	// receipt below; earlier parts remain available for replay assembly.
	_, err = tx.Exec(ctx, `DELETE FROM machine_event_receipts WHERE workspace_id=$1 AND event_id=$2 AND outcome=$3`, branch, id, outcome)
	return true, assembled, err
}

// Hint publishes an authenticated file invalidation through the existing
// LISTEN broker. It creates no activity, version row or durable receipt.
func (s *BurstIngest) Hint(ctx context.Context, connection *Connection, branch string, event Event) error {
	if s == nil || s.Pool == nil || s.Objects == nil {
		return ErrNotReady
	}
	if connection == nil || connection.registry == nil || connection.boot == nil {
		return ErrUnauthorized
	}
	if event.Seq != 0 || event.EventID != ([16]byte{}) {
		return wire.BadValue
	}
	hint, err := wire.DecodeFileWritten(event.Payload)
	if err != nil {
		return err
	}
	if !validBurstPath(hint.Path) {
		return wire.BadValue
	}
	if err := connection.RequireReady(branch); err != nil {
		return err
	}
	// Resolve historical authority outside the registry lock. Recheck the
	// same lease before publishing anything.
	actor, err := s.resolveLegacyActor(ctx, branch, hint.Actor)
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackActorEvent(ctx, tx)
	if actor == nil {
		actor, err = resolveStoredEventActor(ctx, tx, branch, connection.boot.machine, hint.Actor)
		if err != nil {
			return err
		}
	}
	r := connection.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if !connection.current() || connection.boot.branch != branch {
		return ErrUnauthorized
	}
	if !connection.ready {
		return ErrNotReady
	}
	data, err := json.Marshal(map[string]any{"kind": "file_written", "path": hint.Path, "post_digest": hint.PostDigest, "actor": json.RawMessage(actor)})
	if err != nil {
		return err
	}
	if len(data) >= 8000 {
		return wire.BadValue
	}
	_, err = tx.Exec(ctx, `SELECT pg_notify($1,$2)`, "branch_"+strings.ReplaceAll(branch, "-", "")+"_files", string(data))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Preserve legacy migration without exposing host references to its adapter.
// It may need a pool connection, so it precedes both locks. Current presence
// cannot establish historical authority and is never bound by production.
func (s *BurstIngest) resolveLegacyActor(ctx context.Context, branch string, actor wire.Actor) (json.RawMessage, error) {
	if actor.Kind != 2 && actor.Kind != 3 {
		return nil, nil
	}
	if s.ResolveActor == nil {
		return nil, ErrHistoricalActorUnavailable
	}
	value, err := s.ResolveActor(ctx, branch, actor)
	if err != nil {
		return nil, err
	}
	if !json.Valid(value) {
		return nil, ErrUnauthorized
	}
	return value, nil
}

// An authenticated machine can only resolve its own committed references.
// Unknown references never fall back to a live session, roster or outside actor.
// Stored data uses the shared branch actor renderer's historical representation.
func resolveStoredEventActor(ctx context.Context, tx pgx.Tx, branch, machine string, actor wire.Actor) (json.RawMessage, error) {
	switch actor.Kind {
	case 1:
		identity, err := ResolveActorInTx(ctx, tx, branch, machine, actor.Principal)
		if err != nil {
			return nil, err
		}
		member := strconv.FormatInt(identity.MemberID, 10)
		if identity.Kind == "person" {
			return json.Marshal(map[string]any{"kind": "person", "id": "member:" + member, "member_id": member, "via": identity.Via})
		}
		return json.Marshal(map[string]any{"kind": "agent", "id": "run:" + identity.Run, "run_id": identity.Run, "agent_kind": identity.AgentKind, "for_member": member})
	case 4:
		return json.RawMessage(`{"kind":"outside","color_index":7}`), nil
	default:
		return nil, ErrUnauthorized
	}
}

func rollbackActorEvent(ctx context.Context, tx pgx.Tx) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(cleanup)
}
