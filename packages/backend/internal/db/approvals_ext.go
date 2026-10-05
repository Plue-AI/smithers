package db

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const expireApproval = `
UPDATE approvals
SET state = 'expired',
    decided_at = NOW(),
    decided_by = NULL
WHERE id = $1
  AND repository_id = $2
  AND state = 'pending'
  AND kind NOT IN ('one_click', 'review_merge')
  AND expires_at < $3
RETURNING id, session_id, repository_id, state, kind, title, description, created_at, decided_at, decided_by, expires_at, payload
`

type ExpireApprovalParams struct {
	ID           string `json:"id"`
	RepositoryID int64  `json:"repository_id"`
	ExpiresAt    pgtype.Timestamptz
}

// ExpireApproval transitions a pending approval to expired when it has timed out.
func (q *Queries) ExpireApproval(ctx context.Context, arg ExpireApprovalParams) (Approval, error) {
	row := q.db.QueryRow(ctx, expireApproval, arg.ID, arg.RepositoryID, arg.ExpiresAt)
	var i Approval
	err := row.Scan(
		&i.ID,
		&i.SessionID,
		&i.RepositoryID,
		&i.State,
		&i.Kind,
		&i.Title,
		&i.Description,
		&i.CreatedAt,
		&i.DecidedAt,
		&i.DecidedBy,
		&i.ExpiresAt,
		&i.Payload,
	)
	return i, err
}

// ConfirmationApproval is the member-bound form of the existing approvals
// row. The unnumbered T-APP-04 migration and execution providers must qualify
// before any install route uses it; legacy guest approvals never use this API.
type ConfirmationApproval struct {
	Approval
	MemberID        int64
	CredentialID    int64
	Command         string
	Subject         json.RawMessage
	Revision        string
	Generation      pgtype.Int8
	ReviewedHeadSHA pgtype.Text
	RequestKey      string
}

const confirmationApprovalColumns = `id, COALESCE(session_id::text, ''), repository_id,
state, kind, title, description, created_at, decided_at, decided_by, expires_at, payload,
member_id, credential_id, command, subject, revision, generation, reviewed_head_sha, request_key`

func scanConfirmationApproval(row pgx.Row) (ConfirmationApproval, error) {
	var a ConfirmationApproval
	err := row.Scan(&a.ID, &a.SessionID, &a.RepositoryID, &a.State, &a.Kind, &a.Title,
		&a.Description, &a.CreatedAt, &a.DecidedAt, &a.DecidedBy, &a.ExpiresAt, &a.Payload,
		&a.MemberID, &a.CredentialID, &a.Command, &a.Subject, &a.Revision, &a.Generation,
		&a.ReviewedHeadSHA, &a.RequestKey)
	return a, err
}

// CreateConfirmationApproval records a resolved command after authorization
// and subject/consumer checks in the caller's transaction. A duplicate key
// returns ErrNoRows: the service must read the immutable original and compare
// its command, subject and exact input before reporting a replay. It never
// replaces the original row. Neither creation nor this store executes an act.
func (q *Queries) CreateConfirmationApproval(ctx context.Context, a ConfirmationApproval) (ConfirmationApproval, error) {
	return scanConfirmationApproval(q.db.QueryRow(ctx, `INSERT INTO approvals
(id, repository_id, state, kind, title, description, payload, member_id, credential_id,
 command, subject, revision, generation, reviewed_head_sha, request_key, expires_at)
VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()+INTERVAL '24 hours')
ON CONFLICT (repository_id,credential_id,request_key) WHERE member_id IS NOT NULL DO NOTHING
RETURNING `+confirmationApprovalColumns, a.ID, a.RepositoryID, a.Kind, a.Title, a.Description, a.Payload,
		a.MemberID, a.CredentialID, a.Command, a.Subject, a.Revision, a.Generation, a.ReviewedHeadSHA, a.RequestKey))
}

func (q *Queries) GetConfirmationApprovalByRequest(ctx context.Context, repositoryID, memberID, credentialID int64, request string) (ConfirmationApproval, error) {
	return scanConfirmationApproval(q.db.QueryRow(ctx, `SELECT `+confirmationApprovalColumns+`
FROM approvals WHERE repository_id=$1 AND member_id=$2 AND credential_id=$3 AND request_key=$4`,
		repositoryID, memberID, credentialID, request))
}

// LockConfirmationApproval serializes presses on one member's confirmation.
// The service rechecks the current credential, roster, subject and consumer in
// this transaction before execution. A row from another audience is not found.
func (q *Queries) LockConfirmationApproval(ctx context.Context, repositoryID, memberID int64, id string) (ConfirmationApproval, error) {
	return scanConfirmationApproval(q.db.QueryRow(ctx, `SELECT `+confirmationApprovalColumns+`
FROM approvals WHERE id=$1 AND repository_id=$2 AND member_id=$3 FOR UPDATE`, id, repositoryID, memberID))
}

// DecideConfirmationApproval extends the existing pending-row CAS with the
// immutable requester and revision binding. The caller owns the transaction
// containing the subject effect; a refused/unavailable effect leaves pending.
// A terminal row cannot be reopened. Expiry uses the database clock, including
// time spent waiting for a concurrent press's row lock.
func (q *Queries) DecideConfirmationApproval(ctx context.Context, a ConfirmationApproval, state string) (ConfirmationApproval, error) {
	return scanConfirmationApproval(q.db.QueryRow(ctx, `UPDATE approvals
SET state=$1, decided_at=clock_timestamp(),
    decided_by=CASE WHEN $1='expired' THEN NULL ELSE member_id END
WHERE id=$2 AND repository_id=$3 AND member_id=$4 AND credential_id=$5
  AND revision=$6 AND generation IS NOT DISTINCT FROM $7::bigint
  AND reviewed_head_sha IS NOT DISTINCT FROM $8::text AND state='pending'
  AND (($1 IN ('approved','rejected') AND expires_at>clock_timestamp()) OR $1='expired')
RETURNING `+confirmationApprovalColumns, state, a.ID, a.RepositoryID, a.MemberID, a.CredentialID,
		a.Revision, a.Generation, a.ReviewedHeadSHA))
}
