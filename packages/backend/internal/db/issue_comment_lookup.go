package db

import "context"

func (q *Queries) FindIssueCommentKey(ctx context.Context, issueID, userID int64, key string) (id int64, err error) {
	err = q.db.QueryRow(ctx, `SELECT comment_id FROM issue_comment_keys WHERE issue_id=$1 AND user_id=$2 AND key=$3`, issueID, userID, key).Scan(&id)
	return
}
