package services

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

// allocateRosterLogins fixes each login once, including pre-migration owner
// rows. Detached rows retain reservations without granting roster access.
func allocateRosterLogins(ctx context.Context, tx pgx.Tx) error {
	// Serialize install-wide allocations even when two repositories are changed.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(20000,19999)`); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT c.id,c.unix_login,coalesce(c.github_login,u.username)
 FROM collaborators c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.id`)
	if err != nil {
		return err
	}
	type pending struct {
		id     int64
		github string
	}
	var missing []pending
	used := map[string]bool{}
	for rows.Next() {
		var id int64
		var login, github *string
		if err = rows.Scan(&id, &login, &github); err != nil {
			rows.Close()
			return err
		}
		if login != nil {
			used[*login] = true
		} else if github != nil {
			missing = append(missing, pending{id, *github})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, member := range missing {
		login, err := microsandbox.AllocateMemberLogin(member.github, used)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE collaborators SET unix_login=$2 WHERE id=$1 AND unix_login IS NULL`, member.id, login); err != nil {
			return err
		}
		used[login] = true
	}
	return nil
}
