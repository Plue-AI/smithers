package db

import "context"

// InstallationMemberPermission always reads committed roster state. It is not
// cached: removal must refuse the very next authenticated request.
func (q *Queries) InstallationMemberPermission(ctx context.Context, userID int64) (string, error) {
	var permission string
	err := q.db.QueryRow(ctx, `SELECT c.permission FROM collaborators c JOIN users u ON u.id=c.user_id
 JOIN install_settings s ON s.key='github.repository' AND c.repository_id=(s.value->>'repository_id')::bigint
 WHERE c.user_id=$1 AND c.suspended_at IS NULL AND NOT u.prohibit_login`, userID).Scan(&permission)
	return permission, err
}
