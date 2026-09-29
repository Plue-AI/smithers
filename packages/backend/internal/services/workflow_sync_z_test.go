package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestWorkflowSync_Z_LoadDefinitionsMarshalError(t *testing.T) {
	svc := NewWorkflowSyncService(
		&mockWorkflowSyncQuerier{
			getRepoByIDFn: func(context.Context, int64) (db.Repository, error) {
				return db.Repository{ID: 1, Name: "repo", UserID: pgtype.Int8{Int64: 7, Valid: true}}, nil
			},
			getUserByIDFn: func(context.Context, int64) (db.User, error) {
				return db.User{ID: 7, Username: "owner"}, nil
			},
		},
		&mockWorkflowSyncRepoHost{
			listFilesAtChangeFn: func(context.Context, string, string, string, string) ([]repohost.ChangeFile, error) {
				return []repohost.ChangeFile{{Path: ".smithers/workflows/bad.tsx"}}, nil
			},
			getFileAtChangeFn: func(_ context.Context, _, _, _, path string) (repohost.FileContent, error) {
				return repohost.FileContent{Path: path, Content: "workflow"}, nil
			},
		},
		&mockWorkflowSyncParser{
			parseFn: func(context.Context, string, []byte) (*WorkflowConfig, error) {
				return &WorkflowConfig{
					Jobs: map[string]JobConfig{
						"bad": {Steps: []StepConfig{{Agent: map[string]any{"bad": func() {}}}}},
					},
				}, nil
			},
		},
	)
	_, err := svc.LoadDefinitionsFromCommit(context.Background(), 1, "abc123")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "marshal workflow config")
}
