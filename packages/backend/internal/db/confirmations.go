package db

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"time"
)

// Confirmation is the person-bound projection of approvals, not a separate
// store. Run waits never enter this projection.
type Confirmation struct {
	ID              string          `json:"id"`
	MemberID        int64           `json:"-"`
	Kind            string          `json:"kind"`
	State           string          `json:"state"`
	Command         string          `json:"command"`
	Subject         json.RawMessage `json:"subject"`
	Revision        string          `json:"revision"`
	Generation      pgtype.Int8     `json:"generation,omitempty"`
	ReviewedHeadSHA pgtype.Text     `json:"reviewed_head_sha,omitempty"`
	Payload         json.RawMessage `json:"payload"`
	ExpiresAt       time.Time       `json:"expires_at"`
	DecidedAt       *time.Time      `json:"decided_at,omitempty"`
}

const confirmationColumns = `id, member_id, kind, state, command, subject, revision, generation, reviewed_head_sha, payload, expires_at, decided_at`

func (q *Queries) ListMemberConfirmations(ctx context.Context, member int64) ([]Confirmation, error) {
	if err := q.SettleMergedConfirmations(ctx, member, time.Now().UTC()); err != nil {
		return nil, err
	}
	// Expiry is durable even if nobody presses the card. The same projection
	// feeds HTTP and the private live topic, so neither can advertise an
	// elapsed confirmation as pending. Never settle another member's rows or
	// unrelated run waits during this read.
	_, err := q.db.Exec(ctx, `UPDATE approvals SET state='expired', decided_at=now(), decided_by=NULL WHERE member_id=$1 AND state='pending' AND expires_at <= now() AND NOT (command='merge' AND payload ? 'effect')`, member)
	if err != nil {
		return nil, err
	}
	rows, err := q.db.Query(ctx, `SELECT `+confirmationColumns+` FROM approvals WHERE member_id=$1 ORDER BY created_at DESC, id`, member)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Confirmation, 0)
	for rows.Next() {
		var row Confirmation
		if err := rows.Scan(&row.ID, &row.MemberID, &row.Kind, &row.State, &row.Command, &row.Subject, &row.Revision, &row.Generation, &row.ReviewedHeadSHA, &row.Payload, &row.ExpiresAt, &row.DecidedAt); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (q *Queries) GetMemberConfirmation(ctx context.Context, id string, member int64) (Confirmation, error) {
	var row Confirmation
	err := q.db.QueryRow(ctx, `SELECT `+confirmationColumns+` FROM approvals WHERE id=$1 AND member_id=$2`, id, member).Scan(&row.ID, &row.MemberID, &row.Kind, &row.State, &row.Command, &row.Subject, &row.Revision, &row.Generation, &row.ReviewedHeadSHA, &row.Payload, &row.ExpiresAt, &row.DecidedAt)
	return row, err
}

// SettleMemberConfirmation preserves the existing pending-row CAS. It cannot
// decide legacy waits, another person's row, or revive a terminal row.
func (q *Queries) SettleMemberConfirmation(ctx context.Context, id string, member int64, state string) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE approvals SET state=$3, decided_at=now(), decided_by=CASE WHEN $3='expired' THEN NULL ELSE $2 END WHERE id=$1 AND member_id=$2 AND state='pending'`, id, member, state)
	return tag.RowsAffected() == 1, err
}

// ConfirmationPress resolves an immutable browser credential/key binding.
// Its lookup is made after current authorization, never as a shortcut around it.
func (q *Queries) ConfirmationPress(ctx context.Context, credential, key string) (string, error) {
	var id string
	err := q.db.QueryRow(ctx, `SELECT id FROM approvals WHERE (decision_credential=$1 AND decision_key=$2) OR payload->'merge_presses' @> jsonb_build_array(jsonb_build_object('credential',$1::text,'key',$2::text))`, credential, key).Scan(&id)
	return id, err
}

// DecideMemberConfirmation binds the pending-row CAS to the immutable press.
// The caller supplies the subject transaction; expiry or a lost CAS changes no row.
func (q *Queries) DecideMemberConfirmation(ctx context.Context, id string, member int64, credential, key, state string) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE approvals SET state=$5, decided_at=clock_timestamp(),decided_by=$2,decision_credential=$3,decision_key=$4 WHERE id=$1 AND member_id=$2 AND state='pending' AND expires_at > clock_timestamp() AND $5 IN ('approved','rejected')`, id, member, credential, key, state)
	return tag.RowsAffected() == 1, err
}

// SettleMergedConfirmations consumes the merge worker's confirmed-main receipt.
// Transport success, a merge fence, and a merged PR outside main cannot settle.
func (q *Queries) SettleMergedConfirmations(ctx context.Context, member int64, now time.Time) error {
	_, err := q.db.Exec(ctx, `UPDATE approvals a SET payload=jsonb_set(jsonb_set(jsonb_set(a.payload-'effect','{merge_attempt}',to_jsonb(COALESCE((a.payload->>'merge_attempt')::int,0)+1)),'{merge_refusals}',COALESCE(a.payload->'merge_refusals','{}'::jsonb)||jsonb_build_object(a.decision_key,i.checks->'land'->'refused')),'{card,review,merge}',jsonb_build_object('state','ready','detail',i.checks->'land'->'refused'->>'message','on_github',true))
 FROM mythical_items i WHERE a.member_id=$1 AND a.state='pending' AND a.command='merge' AND a.repository_id=i.repository_id
 AND a.subject->>'ref'='T'||i.number::text AND i.checks->'land'->>'request'=a.payload->>'merge_request'
 AND a.payload ? 'effect' AND i.checks->'land'->'refused' IS NOT NULL AND i.pending_op IS NULL`, member)
	if err != nil {
		return err
	}
	_, err = q.db.Exec(ctx, `UPDATE approvals a SET state='approved',decided_at=$2,decided_by=a.member_id,
 payload=jsonb_set(a.payload,'{card,receipt}',jsonb_build_object('by',a.payload->'merge_by','result','done','text','Merged','at',$2::timestamptz))
 FROM mythical_items i WHERE a.member_id=$1 AND a.state='pending' AND a.command='merge'
 AND a.repository_id=i.repository_id AND a.subject->>'ref'='T'||i.number::text
 AND a.generation=i.generation AND a.reviewed_head_sha=i.pr_head
 AND a.revision=i.id::text||':'||i.generation::text||':'||a.reviewed_head_sha
 AND i.state='landed' AND i.pr_merge_commit <> ''
 AND i.checks->'land'->>'request'=a.payload->>'merge_request'
 AND i.checks->'land'->>'session'=a.decision_credential`, member, now)
	return err
}
