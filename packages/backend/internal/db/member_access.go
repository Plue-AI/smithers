package db

import "context"

// InstallationMemberPermission always reads committed roster state. It is not
// cached: removal must refuse the very next authenticated request.
func (q *Queries) InstallationMemberPermission(ctx context.Context, userID int64) (string, error) {
	repositoryID, err := q.InstallRepositoryID(ctx)
	if err != nil {
		return "", err
	}
	var permission string
	err = q.db.QueryRow(ctx, `SELECT c.permission FROM collaborators c JOIN users u ON u.id=c.user_id
 WHERE c.repository_id=$2 AND c.user_id=$1 AND c.suspended_at IS NULL AND NOT u.prohibit_login`, userID, repositoryID).Scan(&permission)
	return permission, err
}
