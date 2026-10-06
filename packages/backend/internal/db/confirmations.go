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
}

const confirmationColumns = `id, member_id, kind, state, command, subject, revision, generation, reviewed_head_sha, payload, expires_at`

func (q *Queries) ListMemberConfirmations(ctx context.Context, member int64) ([]Confirmation, error) {
	rows, err := q.db.Query(ctx, `SELECT `+confirmationColumns+` FROM approvals WHERE member_id=$1 ORDER BY created_at DESC, id`, member)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Confirmation, 0)
	for rows.Next() {
		var row Confirmation
		if err := rows.Scan(&row.ID, &row.MemberID, &row.Kind, &row.State, &row.Command, &row.Subject, &row.Revision, &row.Generation, &row.ReviewedHeadSHA, &row.Payload, &row.ExpiresAt); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (q *Queries) GetMemberConfirmation(ctx context.Context, id string, member int64) (Confirmation, error) {
	var row Confirmation
	err := q.db.QueryRow(ctx, `SELECT `+confirmationColumns+` FROM approvals WHERE id=$1 AND member_id=$2`, id, member).Scan(&row.ID, &row.MemberID, &row.Kind, &row.State, &row.Command, &row.Subject, &row.Revision, &row.Generation, &row.ReviewedHeadSHA, &row.Payload, &row.ExpiresAt)
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
	err := q.db.QueryRow(ctx, `SELECT id FROM approvals WHERE decision_credential=$1 AND decision_key=$2`, credential, key).Scan(&id)
	return id, err
}

func (q *Queries) DenyMemberConfirmation(ctx context.Context, id string, member int64, credential, key string) (bool, error) {
	tag, err := q.db.Exec(ctx, `UPDATE approvals SET state='rejected', decided_at=now(),decided_by=$2,decision_credential=$3,decision_key=$4 WHERE id=$1 AND member_id=$2 AND state='pending'`, id, member, credential, key)
	return tag.RowsAffected() == 1, err
}
