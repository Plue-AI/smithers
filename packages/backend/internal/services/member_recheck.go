package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// MemberRecheckInterval is how often the install rechecks every member's
// write access on GitHub (M-05: re-checked at sign-in and every hour).
const MemberRecheckInterval = time.Hour

// Recheck asks GitHub for every roster member's permission now. A member
// GitHub confirms below write is suspended: in one transaction the row is
// marked and every credential they hold is revoked, as removal does. A
// suspended member GitHub reports with write again is restored; old
// credentials stay revoked, so they sign in again. An unbound repository,
// an installation failure or a failed lookup changes nothing.
func (m *Members) Recheck(ctx context.Context) error {
	if m == nil || m.Pool == nil {
		return nil
	}
	repo, err := m.repository(ctx)
	if err != nil {
		return nil
	}
	token, err := m.installationAccess(ctx, repo)
	if err != nil {
		return fmt.Errorf("members recheck: %w", err)
	}
	type row struct {
		id        int64
		login     string
		user      *int64
		suspended bool
	}
	rows, err := m.Pool.Query(ctx, `SELECT c.id,coalesce(c.github_login,u.username),c.user_id,c.suspended_at IS NOT NULL
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id CROSS JOIN self_host_owners o
 WHERE c.repository_id=$1 AND c.user_id IS DISTINCT FROM o.user_id AND coalesce(c.github_login,u.username) IS NOT NULL ORDER BY c.id`, repo.ID)
	if err != nil {
		return err
	}
	members, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var out row
		return out, r.Scan(&out.id, &out.login, &out.user, &out.suspended)
	})
	if err != nil {
		return err
	}
	var failed []error
	for _, member := range members {
		role, err := m.permission(ctx, token, repo, member.login)
		if err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", member.login, err))
			continue
		}
		switch {
		case role == "" && !member.suspended:
			err = m.suspend(ctx, repo.ID, member.id, member.user)
		case role != "" && member.suspended:
			err = m.restore(ctx, member.id, member.user)
		default:
			continue
		}
		if err != nil {
			failed = append(failed, fmt.Errorf("%s: %w", member.login, err))
		} else {
			slog.InfoContext(ctx, "members.recheck", "login", member.login, "suspended", role == "")
		}
	}
	return errors.Join(failed...)
}

// suspend marks the row and revokes the member's credentials in one
// transaction, under the owner row lock every roster change takes.
func (m *Members) suspend(ctx context.Context, repositoryID, id int64, user *int64) error {
	tx, err := m.lockRoster(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE collaborators SET suspended_at=now() WHERE id=$1 AND suspended_at IS NULL`, id); err != nil {
		return err
	}
	if user != nil {
		if err = revokeMemberCredentials(ctx, tx, repositoryID, *user, 0); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// restore clears a suspension and lifts the sign-in bar it set.
func (m *Members) restore(ctx context.Context, id int64, user *int64) error {
	tx, err := m.lockRoster(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE collaborators SET suspended_at=NULL WHERE id=$1`, id); err != nil {
		return err
	}
	if user != nil {
		if _, err = tx.Exec(ctx, `UPDATE users SET prohibit_login=false WHERE id=$1`, *user); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
