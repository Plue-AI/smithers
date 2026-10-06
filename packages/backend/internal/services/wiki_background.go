package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// WikiBackgroundRuns projects the existing merge-refresh worker onto Home.
// Reading Home never admits a refresh or wakes its machine. Retry and Dismiss
// must come from the shared run provider, with the stored flow/input binding;
// a wiki generation is not a workflow_runs record and offers no substitute.
func (s *MythicalService) WikiBackgroundRuns(ctx context.Context, repository int64) ([]map[string]any, error) {
	row, err := s.queries().GetMythicalWiki(ctx, repository)
	runs := []map[string]any{}
	if errors.Is(err, pgx.ErrNoRows) {
		return runs, nil
	}
	if err != nil {
		return nil, err
	}
	state := ""
	switch {
	case row.State == "off":
		return runs, nil
	case row.Requested:
		state = "queued"
	case row.State == "running":
		state = "running"
	case row.State == "failed":
		state = "failed"
	default:
		return runs, nil
	}
	id := row.RunID
	if id == "" {
		id = fmt.Sprintf("wiki:%d:%d", repository, row.Generation)
	}
	run := map[string]any{"id": id, "title": "Refresh wiki", "state": state, "actions": []any{}}
	if state == "failed" && row.Error != "" {
		run["detail"] = row.Error
	}
	return append(runs, run), nil
}
