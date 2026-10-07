package credits

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultFastDailyTokens is conservative until dogfood's seven-day p90 is measured.
const DefaultFastDailyTokens int64 = 100_000

var ErrInstallCredential = errors.New("invalid install credential")
var ErrFastCapacity = errors.New("daily fast model quota used")

// FastQuota stores only credentials and token counts, never inference content.
// Pending/ambiguous calls consume their bound, including after a process crash.
type FastQuota struct {
	DB          *pgxpool.Pool
	DailyTokens int64
	Now         func() time.Time
}

func (q FastQuota) now() time.Time {
	if q.Now != nil {
		return q.Now().UTC()
	}
	return time.Now().UTC()
}
func (q FastQuota) CurrentTime() time.Time { return q.now() }
func (q FastQuota) ResetAt() time.Time     { return q.now().Truncate(24 * time.Hour).Add(24 * time.Hour) }
func (q FastQuota) Limit() int64 {
	if q.DailyTokens > 0 {
		return q.DailyTokens
	}
	return DefaultFastDailyTokens
}

// Issue binds a credential to a signed-in owner; another owner cannot rotate it.
func (q FastQuota) Issue(ctx context.Context, owner int64, install string) (string, error) {
	return q.issue(ctx, q.DB, owner, install)
}

// IssueInTransaction lets the sign-in grant and credential commit together.
func (q FastQuota) IssueInTransaction(ctx context.Context, tx pgx.Tx, owner int64, install string) (string, error) {
	return q.issue(ctx, tx, owner, install)
}

type fastCredentialWriter interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func (q FastQuota) issue(ctx context.Context, writer fastCredentialWriter, owner int64, install string) (string, error) {
	if _, err := uuid.Parse(install); err != nil || owner <= 0 {
		return "", ErrInstallCredential
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := "smf_" + base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	tag, err := writer.Exec(ctx, `INSERT INTO fast_model_installs(install_id,owner_id,credential_hash) VALUES($1,$2,$3)
 ON CONFLICT(install_id) DO UPDATE SET credential_hash=EXCLUDED.credential_hash, revoked=false
 WHERE fast_model_installs.owner_id=EXCLUDED.owner_id`, install, owner, hash[:])
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", ErrInstallCredential
	}
	return token, nil
}
func (q FastQuota) Revoke(ctx context.Context, owner int64, install string) error {
	if _, err := uuid.Parse(install); err != nil {
		return ErrInstallCredential
	}
	tag, err := q.DB.Exec(ctx, `UPDATE fast_model_installs SET revoked=true WHERE install_id=$1 AND owner_id=$2`, install, owner)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrInstallCredential
	}
	return nil
}
func (q FastQuota) Verify(ctx context.Context, install, token string) error {
	if q.DB == nil {
		return errors.New("fast quota unavailable")
	}
	if _, err := uuid.Parse(install); err != nil || token == "" {
		return ErrInstallCredential
	}
	hash := sha256.Sum256([]byte(token))
	var valid bool
	err := q.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM fast_model_installs WHERE install_id=$1 AND credential_hash=$2 AND NOT revoked)`, install, hash[:]).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrInstallCredential
	}
	return nil
}

// Execute atomically admits a bound under the install lock before one upstream call.
// known is false when the provider might have charged without reporting usage.
func (q FastQuota) Execute(ctx context.Context, install, token string, bound int64, spend func() (tokens int64, known bool, err error)) error {
	if bound <= 0 {
		return ErrFastCapacity
	}
	if err := q.Verify(ctx, install, token); err != nil {
		return err
	}
	now := q.now()
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(token))
	err := pgx.BeginFunc(ctx, q.DB, func(tx pgx.Tx) error {
		var valid bool
		err := tx.QueryRow(ctx, `SELECT credential_hash=$2 AND NOT revoked FROM fast_model_installs WHERE install_id=$1 FOR UPDATE`, install, hash[:]).Scan(&valid)
		if err != nil {
			return err
		}
		if !valid {
			return ErrInstallCredential
		}
		var used int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(tokens),0)::bigint FROM fast_model_counts WHERE install_id=$1 AND created_at >= $2 AND created_at < $3`, install, now.Truncate(24*time.Hour), now.Truncate(24*time.Hour).Add(24*time.Hour)).Scan(&used); err != nil {
			return err
		}
		if bound > q.Limit() || used > q.Limit()-bound {
			return ErrFastCapacity
		}
		_, err = tx.Exec(ctx, `INSERT INTO fast_model_counts(id,install_id,tokens,created_at) VALUES($1,$2,$3,$4)`, id, install, bound, now)
		return err
	})
	if err != nil {
		return err
	}
	tokens, known, spendErr := spend()
	if !known || tokens < 0 {
		tokens = bound
	}
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, err = q.DB.Exec(finish, `UPDATE fast_model_counts SET tokens=$2,settled=true WHERE id=$1`, id, tokens)
	return errors.Join(spendErr, err)
}

// FastDailyTotal is the operator export, including conservative unresolved counts.
type FastDailyTotal struct {
	Install string `json:"install"`
	Day     string `json:"day"`
	Tokens  int64  `json:"tokens"`
}

func (q FastQuota) DailyTotals(ctx context.Context, from, until time.Time) ([]FastDailyTotal, error) {
	rows, err := q.DB.Query(ctx, `SELECT install_id::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD'),sum(tokens)::bigint FROM fast_model_counts WHERE created_at >= $1 AND created_at < $2 GROUP BY 1,2 ORDER BY 2,1`, from, until)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FastDailyTotal{}
	for rows.Next() {
		var row FastDailyTotal
		if err := rows.Scan(&row.Install, &row.Day, &row.Tokens); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (q FastQuota) Remaining(ctx context.Context, install, token string) (int64, error) {
	if err := q.Verify(ctx, install, token); err != nil {
		return 0, err
	}
	var used int64
	day := q.now().Truncate(24 * time.Hour)
	err := q.DB.QueryRow(ctx, `SELECT COALESCE(sum(tokens),0)::bigint FROM fast_model_counts WHERE install_id=$1 AND created_at >= $2 AND created_at < $3`, install, day, day.Add(24*time.Hour)).Scan(&used)
	left := q.Limit() - used
	if left < 0 {
		left = 0
	}
	return left, err
}

// ResolveInstall identifies an install from its host-only credential. An
// explicit install header remains supported and must match the same digest.
func (q FastQuota) ResolveInstall(ctx context.Context, token string) (string, error) {
	if q.DB == nil {
		return "", errors.New("fast quota unavailable")
	}
	if token == "" {
		return "", ErrInstallCredential
	}
	hash := sha256.Sum256([]byte(token))
	var install string
	err := q.DB.QueryRow(ctx, `SELECT install_id::text FROM fast_model_installs WHERE credential_hash=$1 AND NOT revoked`, hash[:]).Scan(&install)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInstallCredential
	}
	return install, err
}
