package services

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

const (
	// maxWorkflowFilesPerSync caps how many workflow files a single commit
	// snapshot may define. Files beyond the cap are recorded as sync errors
	// instead of being fetched and parsed, bounding the repo-host traffic and
	// parser subprocesses a single attacker-controlled push can drive.
	maxWorkflowFilesPerSync = 50
	// maxWorkflowFileBytes caps the size of a single workflow file accepted
	// for parsing; larger files are recorded as sync errors.
	maxWorkflowFileBytes = 256 * 1024
)

// WorkflowSyncQuerier defines database operations needed for workflow sync.
type WorkflowSyncQuerier interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)
	ListWorkflowDefinitionsByRepo(ctx context.Context, arg db.ListWorkflowDefinitionsByRepoParams) ([]db.WorkflowDefinition, error)
	UpsertWorkflowDefinition(ctx context.Context, arg db.UpsertWorkflowDefinitionParams) (db.WorkflowDefinition, error)
	DeactivateWorkflowDefinitionByPath(ctx context.Context, arg db.DeactivateWorkflowDefinitionByPathParams) error
	CreateWorkflowTrigger(ctx context.Context, arg db.CreateWorkflowTriggerParams) (db.WorkflowTrigger, error)
	DisableWorkflowTriggersByRepositoryPath(ctx context.Context, arg db.DisableWorkflowTriggersByRepositoryPathParams) error
	UpsertWorkflowScheduleSpec(ctx context.Context, arg db.UpsertWorkflowScheduleSpecParams) error
	DeleteWorkflowScheduleSpecsByDefinition(ctx context.Context, workflowDefinitionID int64) error
}

// WorkflowSyncRepoHostClient defines repo-host calls required for discovery.
type WorkflowSyncRepoHostClient interface {
	ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

type workflowBookmarkRepoHostClient interface {
	ListBookmarks(ctx context.Context, owner, repo, cursor string, limit int) ([]repohost.Bookmark, string, error)
}

// LoadedWorkflowDefinition is a commit-scoped parsed workflow definition ready for persistence or dispatch.
type LoadedWorkflowDefinition struct {
	Name       string
	Path       string
	Config     json.RawMessage
	ConfigData *WorkflowConfig
}

// WorkflowLoadFileError captures a per-file parse or read failure without aborting the full sync.
type WorkflowLoadFileError struct {
	Path  string
	Error string
	// PreserveExisting marks an unreadable source, whose last known definition
	// and registrations must remain unchanged until the file can be read.
	PreserveExisting bool
}

// WorkflowLoadResult captures the valid definitions and per-file failures found in a commit snapshot.
type WorkflowLoadResult struct {
	Definitions []LoadedWorkflowDefinition
	FileErrors  []WorkflowLoadFileError
}

// WorkflowSyncService discovers TypeScript workflow files and syncs them into DB.
type WorkflowSyncService struct {
	queries  WorkflowSyncQuerier
	repoHost WorkflowSyncRepoHostClient
	parser   WorkflowParser
}

// NewWorkflowSyncService constructs a workflow sync service.
func NewWorkflowSyncService(queries WorkflowSyncQuerier, repoHost WorkflowSyncRepoHostClient, parser WorkflowParser) *WorkflowSyncService {
	return &WorkflowSyncService{
		queries:  queries,
		repoHost: repoHost,
		parser:   parser,
	}
}

// ResolveBookmarkCommit resolves a bookmark from repo-host, the authoritative
// jj store. The legacy SQL bookmark tables are not synchronized by production
// repository mutations and cannot safely pin a remediation checkout.
func (s *WorkflowSyncService) ResolveBookmarkCommit(ctx context.Context, repoID int64, bookmark string) (string, error) {
	bookmark = strings.TrimSpace(bookmark)
	if repoID <= 0 {
		return "", fmt.Errorf("repository id must be positive")
	}
	if bookmark == "" {
		return "", fmt.Errorf("bookmark is required")
	}
	if s == nil || s.queries == nil || s.repoHost == nil {
		return "", fmt.Errorf("bookmark resolution dependencies are not configured")
	}

	repository, err := s.queries.GetRepoByID(ctx, repoID)
	if err != nil {
		return "", fmt.Errorf("load repository: %w", err)
	}
	owner, err := s.resolveRepoOwner(ctx, repository)
	if err != nil {
		return "", err
	}
	bookmarkClient, ok := s.repoHost.(workflowBookmarkRepoHostClient)
	if !ok {
		return "", fmt.Errorf("repo-host bookmark lookup is unavailable")
	}

	const pageSize = 100
	cursor := ""
	seenCursors := map[string]struct{}{"": {}}
	for {
		bookmarks, nextCursor, err := bookmarkClient.ListBookmarks(ctx, owner, repository.Name, cursor, pageSize)
		if err != nil {
			return "", fmt.Errorf("list repository bookmarks: %w", err)
		}
		for _, candidate := range bookmarks {
			if candidate.Name == bookmark {
				commitID := strings.TrimSpace(candidate.TargetCommitID)
				if commitID == "" {
					return "", fmt.Errorf("bookmark %q has no target commit", bookmark)
				}
				return commitID, nil
			}
		}
		nextCursor = strings.TrimSpace(nextCursor)
		if nextCursor == "" {
			return "", fmt.Errorf("bookmark %q not found", bookmark)
		}
		if _, duplicate := seenCursors[nextCursor]; duplicate {
			return "", fmt.Errorf("repo-host bookmark pagination repeated cursor %q", nextCursor)
		}
		seenCursors[nextCursor] = struct{}{}
		cursor = nextCursor
	}
}

// SyncWorkflowsFromCommit discovers, parses, and persists workflow definitions for a commit snapshot.
func (s *WorkflowSyncService) SyncWorkflowsFromCommit(ctx context.Context, repoID int64, commitSHA string) error {
	result, err := s.LoadDefinitionsFromCommit(ctx, repoID, commitSHA)
	if err != nil {
		return err
	}
	return s.PersistDefinitions(ctx, repoID, result)
}

// LoadDefinitionsFromCommit loads workflow definitions from the commit tree without mutating the database.
func (s *WorkflowSyncService) LoadDefinitionsFromCommit(ctx context.Context, repoID int64, commitSHA string) (WorkflowLoadResult, error) {
	if repoID <= 0 {
		return WorkflowLoadResult{}, fmt.Errorf("repository id must be positive")
	}
	if strings.TrimSpace(commitSHA) == "" {
		return WorkflowLoadResult{}, fmt.Errorf("commit sha is required")
	}
	if s.queries == nil || s.repoHost == nil || s.parser == nil {
		return WorkflowLoadResult{}, fmt.Errorf("workflow sync dependencies are not configured")
	}

	repository, err := s.queries.GetRepoByID(ctx, repoID)
	if err != nil {
		return WorkflowLoadResult{}, fmt.Errorf("load repository: %w", err)
	}

	owner, err := s.resolveRepoOwner(ctx, repository)
	if err != nil {
		return WorkflowLoadResult{}, err
	}

	files, err := s.listWorkflowFilesAtChange(ctx, owner, repository.Name, commitSHA)
	if err != nil {
		return WorkflowLoadResult{}, fmt.Errorf("list workflow files: %w", err)
	}

	result := WorkflowLoadResult{}
	loaded := 0
	for _, fileInfo := range files {
		if !isTypeScriptWorkflowPath(fileInfo.Path) {
			continue
		}

		if loaded >= maxWorkflowFilesPerSync {
			result.FileErrors = append(result.FileErrors, WorkflowLoadFileError{
				Path:  fileInfo.Path,
				Error: fmt.Sprintf("workflow file limit exceeded (max %d files per commit)", maxWorkflowFilesPerSync),
			})
			continue
		}
		loaded++

		file, err := s.repoHost.GetFileAtChange(ctx, owner, repository.Name, commitSHA, fileInfo.Path)
		if err != nil {
			result.FileErrors = append(result.FileErrors, WorkflowLoadFileError{
				Path:             fileInfo.Path,
				Error:            err.Error(),
				PreserveExisting: true,
			})
			continue
		}

		var readError string
		switch {
		case file.TooLarge:
			readError = "workflow file too large for repo-host to return its contents"
		case file.Path != fileInfo.Path:
			readError = fmt.Sprintf("workflow file response path %q does not match requested path %q", file.Path, fileInfo.Path)
		case file.Encoding != "" && file.Encoding != "utf8":
			readError = fmt.Sprintf("unsupported workflow file encoding %q", file.Encoding)
		case len(file.Content) > maxWorkflowFileBytes:
			readError = fmt.Sprintf("workflow file too large (%d bytes, max %d)", len(file.Content), maxWorkflowFileBytes)
		}
		if readError != "" {
			result.FileErrors = append(result.FileErrors, WorkflowLoadFileError{
				Path:             fileInfo.Path,
				Error:            readError,
				PreserveExisting: true,
			})
			continue
		}

		cfg, err := s.parser.Parse(ctx, fileInfo.Path, []byte(file.Content))
		if err != nil {
			result.FileErrors = append(result.FileErrors, WorkflowLoadFileError{
				Path:  fileInfo.Path,
				Error: err.Error(),
			})
			continue
		}
		if err := validateWorkflowConfigJobs(cfg); err != nil {
			result.FileErrors = append(result.FileErrors, WorkflowLoadFileError{
				Path:  fileInfo.Path,
				Error: err.Error(),
			})
			continue
		}

		cfgJSON, err := json.Marshal(cfg)
		if err != nil {
			return WorkflowLoadResult{}, fmt.Errorf("marshal workflow config %s: %w", fileInfo.Path, err)
		}

		name := workflowNameFromPath(fileInfo.Path)
		result.Definitions = append(result.Definitions, LoadedWorkflowDefinition{
			Name:       name,
			Path:       fileInfo.Path,
			Config:     cfgJSON,
			ConfigData: cfg,
		})
	}

	return result, nil
}

// PersistDefinitions persists valid definitions and deactivates stale or invalid
// ones, preserving existing state for files that could not be read.
func (s *WorkflowSyncService) PersistDefinitions(ctx context.Context, repoID int64, result WorkflowLoadResult) error {
	if repoID <= 0 {
		return fmt.Errorf("repository id must be positive")
	}
	if s.queries == nil {
		return fmt.Errorf("workflow sync dependencies are not configured")
	}

	existingDefs, err := s.queries.ListWorkflowDefinitionsByRepo(ctx, db.ListWorkflowDefinitionsByRepoParams{
		RepositoryID: repoID,
		PageSize:     1000,
		PageOffset:   0,
	})
	if err != nil {
		return fmt.Errorf("list workflow definitions: %w", err)
	}

	preservedPaths := make(map[string]struct{})
	for _, fileErr := range result.FileErrors {
		if fileErr.PreserveExisting {
			preservedPaths[fileErr.Path] = struct{}{}
		}
	}
	activePaths := make(map[string]struct{}, len(result.Definitions))
	for _, loaded := range result.Definitions {
		if _, preserve := preservedPaths[loaded.Path]; preserve {
			continue
		}
		activePaths[loaded.Path] = struct{}{}

		cfg := loaded.ConfigData
		if cfg == nil {
			cfg = &WorkflowConfig{}
			if err := json.Unmarshal(loaded.Config, cfg); err != nil {
				return fmt.Errorf("decode workflow config %s: %w", loaded.Path, err)
			}
		}
		if err := validateWorkflowConfigJobs(cfg); err != nil {
			return fmt.Errorf("validate workflow config %s: %w", loaded.Path, err)
		}

		def, err := s.queries.UpsertWorkflowDefinition(ctx, db.UpsertWorkflowDefinitionParams{
			RepositoryID: repoID,
			Name:         loaded.Name,
			Path:         loaded.Path,
			Config:       loaded.Config,
		})
		if err != nil {
			return fmt.Errorf("upsert workflow definition %s: %w", loaded.Path, err)
		}

		if err := s.syncWorkflowTriggers(ctx, def, cfg); err != nil {
			return fmt.Errorf("sync workflow triggers for %s: %w", loaded.Path, err)
		}
		if err := s.syncScheduleSpecs(ctx, def, cfg); err != nil {
			return fmt.Errorf("sync schedule specs for %s: %w", loaded.Path, err)
		}
	}

	stalePaths := make(map[string]int64)
	for _, existing := range existingDefs {
		if _, preserve := preservedPaths[existing.Path]; preserve {
			continue
		}
		if _, ok := activePaths[existing.Path]; ok {
			continue
		}
		stalePaths[existing.Path] = existing.ID
	}
	for _, fileErr := range result.FileErrors {
		if _, preserve := preservedPaths[fileErr.Path]; preserve {
			continue
		}
		for _, existing := range existingDefs {
			if existing.Path == fileErr.Path {
				stalePaths[fileErr.Path] = existing.ID
			}
		}
	}

	for stalePath, defID := range stalePaths {
		if err := s.queries.DeleteWorkflowScheduleSpecsByDefinition(ctx, defID); err != nil {
			return fmt.Errorf("delete schedule specs for %s: %w", stalePath, err)
		}
		if err := s.queries.DisableWorkflowTriggersByRepositoryPath(ctx, db.DisableWorkflowTriggersByRepositoryPathParams{
			RepositoryID: repoID,
			WorkflowPath: stalePath,
		}); err != nil {
			return fmt.Errorf("disable workflow triggers for %s: %w", stalePath, err)
		}
		if err := s.queries.DeactivateWorkflowDefinitionByPath(ctx, db.DeactivateWorkflowDefinitionByPathParams{
			RepositoryID: repoID,
			Path:         stalePath,
		}); err != nil {
			return fmt.Errorf("deactivate workflow definition %s: %w", stalePath, err)
		}
	}

	return nil
}

func (s *WorkflowSyncService) resolveRepoOwner(ctx context.Context, repository db.Repository) (string, error) {
	if repository.UserID.Valid {
		user, err := s.queries.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner user: %w", err)
		}
		return user.Username, nil
	}
	if repository.OrgID.Valid {
		org, err := s.queries.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner org: %w", err)
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("repository %d has no owner namespace", repository.ID)
}

func isTypeScriptWorkflowPath(filePath string) bool {
	if !strings.HasPrefix(filePath, ".smithers/workflows/") {
		return false
	}
	return strings.HasSuffix(filePath, ".tsx") || strings.HasSuffix(filePath, ".ts")
}

// workflowNameFromPath derives a workflow name from its file path by stripping
// the directory prefix and the TypeScript file extension (.tsx or .ts).
func workflowNameFromPath(filePath string) string {
	base := path.Base(filePath)
	if strings.HasSuffix(base, ".tsx") {
		return strings.TrimSuffix(base, ".tsx")
	}
	return strings.TrimSuffix(base, ".ts")
}

func (s *WorkflowSyncService) syncScheduleSpecs(ctx context.Context, def db.WorkflowDefinition, cfg *WorkflowConfig) error {
	// Clear existing specs
	if err := s.queries.DeleteWorkflowScheduleSpecsByDefinition(ctx, def.ID); err != nil {
		return fmt.Errorf("delete old specs: %w", err)
	}

	// Extract schedule triggers
	if len(cfg.On.Schedule) == 0 {
		return nil
	}

	now := time.Now()
	for _, spec := range cfg.On.Schedule {
		if spec.Cron == "" {
			continue // ignore invalid configs
		}

		nextFire, err := nextFireTime(spec.Cron, now)
		if err != nil {
			// Skip invalid cron expressions but continue processing valid ones
			continue
		}

		err = s.queries.UpsertWorkflowScheduleSpec(ctx, db.UpsertWorkflowScheduleSpecParams{
			WorkflowDefinitionID: def.ID,
			RepositoryID:         def.RepositoryID,
			CronExpression:       spec.Cron,
			NextFireAt:           nextFire,
		})
		if err != nil {
			return fmt.Errorf("upsert schedule spec: %w", err)
		}
	}

	return nil
}

func (s *WorkflowSyncService) syncWorkflowTriggers(ctx context.Context, def db.WorkflowDefinition, cfg *WorkflowConfig) error {
	if err := s.queries.DisableWorkflowTriggersByRepositoryPath(ctx, db.DisableWorkflowTriggersByRepositoryPathParams{
		RepositoryID: def.RepositoryID,
		WorkflowPath: def.Path,
	}); err != nil {
		return fmt.Errorf("disable previous trigger rows: %w", err)
	}

	for _, trigger := range collectRegisteredWorkflowTriggers(cfg) {
		if _, err := s.queries.CreateWorkflowTrigger(ctx, db.CreateWorkflowTriggerParams{
			RepositoryID:         def.RepositoryID,
			WorkflowDefinitionID: def.ID,
			WorkflowPath:         def.Path,
			EventType:            trigger.EventType,
			EventAction:          trigger.EventAction,
			Enabled:              true,
		}); err != nil {
			return fmt.Errorf("upsert trigger row (%s/%s): %w", trigger.EventType, trigger.EventAction, err)
		}
	}

	return nil
}

func (s *WorkflowSyncService) listWorkflowFilesAtChange(
	ctx context.Context,
	owner string,
	repo string,
	changeID string,
) ([]repohost.ChangeFile, error) {
	prefixes := []string{".smithers/workflows"}
	for _, prefix := range prefixes {
		files, err := s.repoHost.ListFilesAtChange(ctx, owner, repo, changeID, prefix)
		if err != nil {
			return nil, err
		}
		if len(files) > 0 {
			return files, nil
		}
	}
	return nil, nil
}
