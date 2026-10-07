package machined

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ActorIdentity is immutable historical attribution selected by the host's
// authorizer. It is never accepted from a browser/guest as launch authority.
// Person and run identities retain their member/sponsor after revocation.
type ActorIdentity struct {
	Kind      string `json:"kind"`
	MemberID  int64  `json:"member_id"`
	Run       string `json:"run,omitempty"`
	AgentKind string `json:"agent_kind,omitempty"`
	Via       string `json:"via"`
}

func (a ActorIdentity) canonical() ([]byte, error) {
	if a.MemberID <= 0 {
		return nil, ErrUnauthorized
	}
	switch a.Via {
	case "ssh", "terminal", "cli", "web", "agent":
	default:
		return nil, ErrUnauthorized
	}
	switch a.Kind {
	case "person":
		if a.Run != "" || a.AgentKind != "" || a.Via == "agent" {
			return nil, ErrUnauthorized
		}
	case "agent":
		if a.Run == "" || !validString(a.Run) || strings.TrimSpace(a.Run) != a.Run {
			return nil, ErrUnauthorized
		}
		switch a.AgentKind {
		case "coding", "reviewer", "external":
		default:
			return nil, ErrUnauthorized
		}
	default:
		return nil, ErrUnauthorized
	}
	raw, err := json.Marshal(a)
	if err != nil || len(raw) > 768 {
		return nil, ErrUnauthorized
	}
	return raw, nil
}
func actorScope(branch, machine string) error {
	id, err := uuid.Parse(branch)
	if err != nil || id == uuid.Nil || id.String() != branch || machine == "" || len(machine) > 1024 || !validString(machine) {
		return ErrUnauthorized
	}
	return nil
}

// CommitActor runs the trusted admission resolver in the same transaction as
// attribution persistence. No reference escapes on resolver or commit failure.
// The resolver must authorize this request using the supplied transaction;
// it must not launch processes, send guest traffic, or retain the transaction.
func CommitActor(ctx context.Context, pool *pgxpool.Pool, branch, machine string,
	authorize func(context.Context, pgx.Tx) (ActorIdentity, error)) ([]byte, error) {
	if pool == nil || authorize == nil {
		return nil, ErrNotReady
	}
	var reference []byte
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		actor, err := authorize(ctx, tx)
		if err != nil {
			return err
		}
		reference, err = RecordActorInTx(ctx, tx, branch, machine, actor)
		return err
	})
	if err != nil {
		return nil, err
	}
	return reference, nil
}

// RecordActorInTx records an already-authorized identity using the caller's
// transaction and lock order. The caller MUST commit successfully before using
// the returned bytes in a guest request. It must not send network traffic while
// this transaction is open. Repeated admissions reuse the exact immutable row.
// This storage boundary grants no permission; authorizers must still run for
// every launch, including when its attribution reference already exists.
func RecordActorInTx(ctx context.Context, tx pgx.Tx, branch, machine string, actor ActorIdentity) ([]byte, error) {
	if tx == nil {
		return nil, ErrNotReady
	}
	if err := actorScope(branch, machine); err != nil {
		return nil, err
	}
	raw, err := actor.canonical()
	if err != nil {
		return nil, err
	}
	var present int
	if err = tx.QueryRow(ctx, `SELECT 1 FROM workspaces WHERE id=$1 AND vm_id=$2 AND deleted_at IS NULL FOR SHARE`, branch, machine).Scan(&present); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	id := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO machine_actor_references(id,workspace_id,machine_id,actor,digest)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,machine_id,digest) DO NOTHING`, id.String(), branch, machine, raw, digest[:])
	if err != nil {
		return nil, err
	}
	var key string
	var stored []byte
	if err = tx.QueryRow(ctx, `SELECT id::text,actor FROM machine_actor_references WHERE workspace_id=$1 AND machine_id=$2 AND digest=$3`, branch, machine, digest[:]).Scan(&key, &stored); err != nil {
		return nil, err
	}
	// A hash collision or incompatible historical row cannot adopt new identity.
	previous, err := decodeActorIdentity(stored, digest[:])
	if err != nil || previous != actor {
		return nil, ErrUnauthorized
	}
	id, err = uuid.Parse(key)
	if err != nil || id == uuid.Nil {
		return nil, ErrUnauthorized
	}
	return append([]byte(nil), id[:]...), nil
}

func decodeActorIdentity(raw, digest []byte) (ActorIdentity, error) {
	var actor ActorIdentity
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&actor) != nil {
		return actor, ErrUnauthorized
	}
	canonical, err := actor.canonical()
	if err != nil {
		return actor, err
	}
	sum := sha256.Sum256(canonical)
	if subtle.ConstantTimeCompare(sum[:], digest) != 1 {
		return actor, ErrUnauthorized
	}
	return actor, nil
}

// ResolveActorInTx is a historical lookup under the event's authenticated
// workspace/machine scope. It deliberately does not consult the current roster
// or live session map. Replay may precede readiness or follow member removal.
// The event pump owns its connection fence and commit-before-ACK transaction.
func ResolveActorInTx(ctx context.Context, tx pgx.Tx, branch, machine string, reference []byte) (ActorIdentity, error) {
	if tx == nil {
		return ActorIdentity{}, ErrNotReady
	}
	if err := actorScope(branch, machine); err != nil {
		return ActorIdentity{}, err
	}
	id, err := uuid.FromBytes(reference)
	if err != nil || id == uuid.Nil {
		return ActorIdentity{}, ErrUnauthorized
	}
	var raw, digest []byte
	err = tx.QueryRow(ctx, `SELECT actor,digest FROM machine_actor_references WHERE id=$1 AND workspace_id=$2 AND machine_id=$3`, id.String(), branch, machine).Scan(&raw, &digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return ActorIdentity{}, ErrUnauthorized
	}
	if err != nil {
		return ActorIdentity{}, err
	}
	return decodeActorIdentity(raw, digest)
}
