package db

import "context"

// CodingFileHostIsActive resolves the same issuer-owned host fence that the
// file writer later locks through the complete provider operation.
func (q *Queries) CodingFileHostIsActive(ctx context.Context, host string, user, repository int64, workspace, fence string) (bool, error) {
	var live bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM flow_runtime_host_bindings
        WHERE id=$1::uuid AND user_id=$2 AND repository_id=$3 AND workspace_id=$4::uuid
        AND state IN ('starting','running') AND encode(credential_hash,'hex')=$5)`,
		host, user, repository, workspace, fence).Scan(&live)
	return live, err
}
