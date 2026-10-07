package services

import (
	"context"
	"fmt"
)

// LearningBackgroundRuns reads the dispatcher's durable state. Completed and
// cancelled work leaves Home; no source read or projection wakes a machine.
func (s *MythicalService) LearningBackgroundRuns(ctx context.Context, repository int64) ([]map[string]any, error) {
	rows, err := s.store.Query(ctx, `SELECT r.id,r.state,i.number FROM product_job_requests r
 JOIN mythical_items i ON i.id::text=r.payload->'target'->>'BindingID' AND i.repository_id=$1
 WHERE r.tenant_id=$2 AND r.operation='flow.runtime.launch'
 AND i.state='landed' AND i.pr_state='merged'
 AND r.payload->'target'->>'TenantID'=r.tenant_id
 AND r.payload->'target'->>'PrincipalID'=r.principal_id
 AND r.payload->'payload'->>'todo'=i.number::text
 AND r.payload->>'flowId'='learning' AND r.payload->'target'->>'BindingKind'='learning'
 AND r.state NOT IN ('completed','cancelled')
 UNION ALL
 SELECT r.id,r.state,i.number FROM product_job_requests r
 JOIN mythical_items i ON i.id::text=r.payload->>'item' AND i.repository_id=$1
 WHERE r.tenant_id=$2 AND r.operation='learning.admission'
 AND i.source='todo' AND i.state='landed' AND i.pr_state='merged'
 AND r.payload->>'repository'=i.repository_id::text
 AND r.payload->>'todo'=i.number::text AND r.payload->>'commit'=i.pr_merge_commit
 AND r.principal_id='user:' || i.owner_id::text
 AND r.state NOT IN ('completed','cancelled') ORDER BY id`, repository, fmt.Sprintf("repository:%d", repository))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []map[string]any{}
	for rows.Next() {
		var id, state string
		var todo int64
		if err := rows.Scan(&id, &state, &todo); err != nil {
			return nil, err
		}
		switch state {
		case "accepted", "dispatching":
			state = "queued"
		case "uncertain":
			state = "failed"
		case "running", "waiting", "failed":
		default:
			return nil, fmt.Errorf("unknown Learning dispatch state %q", state)
		}
		runs = append(runs, map[string]any{"id": id, "title": fmt.Sprintf("Learning · T%d", todo), "state": state, "actions": []any{}})
	}
	return runs, rows.Err()
}
