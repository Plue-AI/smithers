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
	err = q.db.QueryRow(ctx, `SELECT CASE WHEN c.suspended_at IS NULL AND NOT u.prohibit_login THEN c.permission ELSE '' END FROM collaborators c JOIN users u ON u.id=c.user_id
 WHERE c.repository_id=$2 AND c.user_id=$1`, userID, repositoryID).Scan(&permission)
	return permission, err
}

// PresenceSessionMember resolves the admitted Unix account through committed
// member allocations. A reused login with a different UID grants no identity.
func (q *Queries) PresenceSessionMember(ctx context.Context, repository int64, login string, uid uint32) (User, error) {
	var id int64
	err := q.db.QueryRow(ctx, `SELECT c.user_id FROM collaborators c JOIN users u ON u.id=c.user_id
 WHERE c.repository_id=$1 AND c.unix_login=$2 AND c.unix_uid=$3
 AND c.suspended_at IS NULL AND c.permission IN ('admin','write') AND NOT u.prohibit_login`, repository, login, uid).Scan(&id)
	if err != nil {
		return User{}, err
	}
	return q.GetUserByID(ctx, id)
}
