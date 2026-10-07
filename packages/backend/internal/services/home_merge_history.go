package services

import (
	"context"
	"strconv"
)

// MergeHistory is Home's shared merge facts (HomeCardSchema merge_history,
// spec §14.3): every merged TODO with the repository source position of the
// first fact that recorded it merged, oldest first. The positions are the
// home topic's own cursor space. Each browser derives "N merged since you
// looked" from them and its member's own last_seen_seq (§7.2.2); no member's
// last look enters this shared list.
func (s *MythicalService) MergeHistory(ctx context.Context, repository int64) ([]map[string]any, error) {
	rows, err := s.store.Query(ctx, `SELECT i.number, min(e.repository_sequence)
 FROM mythical_items i JOIN product_job_events e ON e.tenant_id=$2 AND e.principal_id='todo:'||i.id::text
 WHERE i.repository_id=$1 AND i.number IS NOT NULL AND e.state='merged' AND e.repository_sequence IS NOT NULL
 GROUP BY i.number ORDER BY 2, 1`, repository, strconv.FormatInt(repository, 10))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	history := []map[string]any{}
	for rows.Next() {
		var n, seq int64
		if err := rows.Scan(&n, &seq); err != nil {
			return nil, err
		}
		history = append(history, map[string]any{"n": n, "seq": seq})
	}
	return history, rows.Err()
}
