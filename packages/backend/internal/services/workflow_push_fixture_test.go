package services

import (
	"context"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Existing dispatch tests focus on job graphs, writes, and credentials. Their
// repository fixture has the supplied push revision at its default head and
// the same workflow files as its definition fixtures. Head changes, missing
// files, and unavailable readers use the real constructor in workflow_default_head_test.go.
// A fake reader lets these unit tests inject malformed configs and DB failures
// without launching the TypeScript parser or a repository storage process.
type currentPushTestService struct {
	WorkflowRunService
	service *workflowRunService
}

func newCurrentPushTestService(q WorkflowRunQuerier, opts ...WorkflowRunServiceOption) WorkflowRunService {
	s := NewWorkflowRunService(q, opts...).(*workflowRunService)
	return &currentPushTestService{WorkflowRunService: s, service: s}
}

type workflowPushFixtureLoader func(context.Context, int64, string) (WorkflowLoadResult, error)

func (load workflowPushFixtureLoader) LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commit string) (WorkflowLoadResult, error) {
	return load(ctx, repoID, commit)
}

func (s *currentPushTestService) DispatchForEvent(ctx context.Context, input DispatchForEventInput) ([]WorkflowRunResult, error) {
	service := *s.service
	if NormalizeTriggerName(input.Event.Type) == "push" {
		if input.Event.CommitSHA == "" {
			input.Event.CommitSHA = strings.Repeat("c", 40)
		}
		if service.bookmarkResolver == nil {
			service.bookmarkResolver = &recordingWorkflowBookmarkCommitResolver{commit: input.Event.CommitSHA}
		}
		if service.definitionLoader == nil {
			service.definitionLoader = workflowPushFixtureLoader(func(ctx context.Context, repoID int64, _ string) (WorkflowLoadResult, error) {
				if input.UseLoadedDefinitions {
					return WorkflowLoadResult{Definitions: input.LoadedDefinitions}, nil
				}
				var rows []db.WorkflowDefinition
				if input.WorkflowDefinitionID != nil {
					def, err := service.queries.GetWorkflowDefinition(ctx, db.GetWorkflowDefinitionParams{ID: *input.WorkflowDefinitionID, RepositoryID: repoID})
					if err != nil {
						return WorkflowLoadResult{}, err
					}
					rows = []db.WorkflowDefinition{def}
				} else {
					var err error
					rows, err = service.queries.ListWorkflowDefinitionsByRepo(ctx, db.ListWorkflowDefinitionsByRepoParams{RepositoryID: repoID, PageSize: 100})
					if err != nil {
						return WorkflowLoadResult{}, err
					}
				}
				result := WorkflowLoadResult{}
				for _, def := range rows {
					result.Definitions = append(result.Definitions, LoadedWorkflowDefinition{Name: def.Name, Path: def.Path, Config: def.Config})
				}
				return result, nil
			})
		}
	}
	return service.DispatchForEvent(ctx, input)
}
