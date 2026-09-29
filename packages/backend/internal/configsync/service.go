package configsync

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

type RepoHostClient interface {
	ListFilesAtChange(ctx context.Context, owner, repo, changeID, prefix string) ([]repohost.ChangeFile, error)
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

type Store interface {
	GetRepoByID(ctx context.Context, id int64) (db.Repository, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	GetOrgByID(ctx context.Context, id int64) (db.Organization, error)

	UpdateRepoConfigState(ctx context.Context, arg db.UpdateRepoConfigStateParams) (db.Repository, error)

	ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error)
	UpsertProtectedBookmark(ctx context.Context, arg db.UpsertProtectedBookmarkParams) (db.ProtectedBookmark, error)
	DeleteProtectedBookmarkByPattern(ctx context.Context, arg db.DeleteProtectedBookmarkByPatternParams) (int64, error)

	ListAllLabelsByRepo(ctx context.Context, repositoryID int64) ([]db.Label, error)
	CreateLabel(ctx context.Context, arg db.CreateLabelParams) (db.Label, error)
	UpdateLabel(ctx context.Context, arg db.UpdateLabelParams) (db.Label, error)
	DeleteLabel(ctx context.Context, arg db.DeleteLabelParams) error
	CountIssueLabelsByLabel(ctx context.Context, labelID int64) (int64, error)

	ListWebhooksByRepo(ctx context.Context, repositoryID int64) ([]db.Webhook, error)
	CreateWebhook(ctx context.Context, arg db.CreateWebhookParams) (db.Webhook, error)
	UpdateWebhookByID(ctx context.Context, arg db.UpdateWebhookByIDParams) (db.Webhook, error)
	DeleteWebhookByID(ctx context.Context, arg db.DeleteWebhookByIDParams) error

	GetSecretValueByName(ctx context.Context, arg db.GetSecretValueByNameParams) ([]byte, error)
}

type AuditLogger interface {
	Log(ctx context.Context, event services.AuditEvent)
}

type Service struct {
	store       Store
	repoHost    RepoHostClient
	secretCodec webhook.SecretCodec
	audit       AuditLogger
	beginTx     func(ctx context.Context) (Store, func(success bool) error, error)
}

type syncPlan struct {
	repoUpdate      *db.UpdateRepoConfigStateParams
	bookmarksUpsert []db.UpsertProtectedBookmarkParams
	bookmarksDelete []db.DeleteProtectedBookmarkByPatternParams
	labelsCreate    []db.CreateLabelParams
	labelsUpdate    []db.UpdateLabelParams
	labelsDelete    []db.DeleteLabelParams
	webhooksCreate  []db.CreateWebhookParams
	webhooksUpdate  []db.UpdateWebhookByIDParams
	webhooksDelete  []db.DeleteWebhookByIDParams
	changes         []Change
	warnings        []SyncWarning
}

func NewService(queries *db.Queries, repoHost RepoHostClient, secretCodec webhook.SecretCodec, audit AuditLogger) *Service {
	codec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if secretCodec != nil {
		codec = secretCodec
	}

	return &Service{
		store:       queries,
		repoHost:    repoHost,
		secretCodec: codec,
		audit:       audit,
		beginTx: func(ctx context.Context) (Store, func(success bool) error, error) {
			tx, err := queries.BeginTx(ctx)
			if err != nil {
				return nil, nil, err
			}
			txQueries := queries.WithTx(tx)
			return txQueries, func(success bool) error {
				if success {
					return tx.Commit(ctx)
				}
				return tx.Rollback(ctx)
			}, nil
		},
	}
}

func newServiceWithStore(store Store, repoHost RepoHostClient, secretCodec webhook.SecretCodec, audit AuditLogger, beginTx func(context.Context) (Store, func(bool) error, error)) *Service {
	codec := webhook.SecretCodec(webhook.NoopSecretCodec{})
	if secretCodec != nil {
		codec = secretCodec
	}
	return &Service{
		store:       store,
		repoHost:    repoHost,
		secretCodec: codec,
		audit:       audit,
		beginTx:     beginTx,
	}
}

func (s *Service) LoadParsedConfigFromCommit(ctx context.Context, repositoryID int64, commitSHA string) (ParsedConfig, error) {
	if repositoryID <= 0 {
		return ParsedConfig{}, fmt.Errorf("repository id must be positive")
	}
	if strings.TrimSpace(commitSHA) == "" {
		return ParsedConfig{}, fmt.Errorf("commit sha is required")
	}
	if s.store == nil || s.repoHost == nil {
		return ParsedConfig{}, fmt.Errorf("config sync dependencies are not configured")
	}

	repository, err := s.store.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return ParsedConfig{}, fmt.Errorf("load repository: %w", err)
	}

	owner, err := s.resolveRepoOwner(ctx, repository)
	if err != nil {
		return ParsedConfig{}, err
	}

	listedFiles, err := s.repoHost.ListFilesAtChange(ctx, owner, repository.Name, commitSHA, ".smithers")
	if err != nil {
		return ParsedConfig{}, fmt.Errorf("list .smithers files: %w", err)
	}

	present := make(map[string]struct{}, len(listedFiles))
	for _, file := range listedFiles {
		present[file.Path] = struct{}{}
	}

	files := make(map[string][]byte, 4)
	for _, filePath := range []string{configFilePath, protectedBookmarksFilePath, labelsFilePath, webhooksFilePath} {
		if _, ok := present[filePath]; !ok {
			continue
		}
		file, err := s.repoHost.GetFileAtChange(ctx, owner, repository.Name, commitSHA, filePath)
		if err != nil {
			return ParsedConfig{}, fmt.Errorf("read %s: %w", filePath, err)
		}
		if file.Path != filePath {
			return ParsedConfig{}, fmt.Errorf("read %s: repository host returned mismatched file path %q", filePath, file.Path)
		}
		if file.TooLarge {
			return ParsedConfig{}, fmt.Errorf("read %s: file exceeds repository host read limit", filePath)
		}
		if file.Encoding != "" && file.Encoding != "utf8" {
			return ParsedConfig{}, fmt.Errorf("read %s: unsupported content encoding %q", filePath, file.Encoding)
		}
		files[filePath] = []byte(file.Content)
	}

	return ParseConfigFiles(files)
}

func (s *Service) SyncFromCommit(ctx context.Context, input SyncInput) (SyncResult, error) {
	parsed, err := s.LoadParsedConfigFromCommit(ctx, input.RepositoryID, input.CommitSHA)
	if err != nil {
		s.logFailure(ctx, input, err, "")
		return SyncResult{}, err
	}
	return s.SyncParsedConfig(ctx, input, parsed)
}

func (s *Service) SyncParsedConfig(ctx context.Context, input SyncInput, parsed ParsedConfig) (SyncResult, error) {
	result := SyncResult{
		DryRun:         input.DryRun,
		FilesProcessed: filesProcessed(parsed),
	}

	repository, err := s.store.GetRepoByID(ctx, input.RepositoryID)
	if err != nil {
		s.logFailure(ctx, input, err, "")
		return SyncResult{}, fmt.Errorf("load repository: %w", err)
	}

	plan, err := s.buildPlan(ctx, repository, parsed)
	if err != nil {
		s.logFailure(ctx, input, err, repository.Name)
		return SyncResult{}, err
	}

	result.Changes = plan.changes
	result.Warnings = plan.warnings

	if input.DryRun || len(plan.changes) == 0 {
		s.logAuditEvents(ctx, input, repository.Name, result)
		return result, nil
	}

	txStore := s.store
	finishTx := func(bool) error { return nil }
	if s.beginTx != nil {
		store, finish, err := s.beginTx(ctx)
		if err != nil {
			s.logFailure(ctx, input, err, repository.Name)
			return SyncResult{}, fmt.Errorf("begin config sync transaction: %w", err)
		}
		txStore = store
		finishTx = finish
	}

	finalized := false
	defer func() {
		if !finalized {
			_ = finishTx(false)
		}
	}()

	if err := applyPlan(ctx, txStore, plan); err != nil {
		s.logFailure(ctx, input, err, repository.Name)
		return SyncResult{}, err
	}

	commitErr := finishTx(true)
	finalized = true
	if commitErr != nil {
		err := fmt.Errorf("commit config sync transaction: %w", commitErr)
		s.logFailure(ctx, input, err, repository.Name)
		return SyncResult{}, err
	}

	s.logAuditEvents(ctx, input, repository.Name, result)
	return result, nil
}

func (s *Service) buildPlan(ctx context.Context, repository db.Repository, parsed ParsedConfig) (syncPlan, error) {
	var plan syncPlan

	if parsed.ConfigFilePresent {
		update, changes := buildRepoUpdate(repository, parsed.Config)
		plan.repoUpdate = update
		plan.changes = append(plan.changes, changes...)
	}

	if parsed.ProtectedBookmarksFilePresent {
		current, err := s.store.ListAllProtectedBookmarksByRepo(ctx, repository.ID)
		if err != nil {
			return syncPlan{}, fmt.Errorf("list protected bookmarks: %w", err)
		}
		upsert, deletes, changes := buildProtectedBookmarkChanges(repository.ID, current, parsed.ProtectedBookmarks)
		plan.bookmarksUpsert = upsert
		plan.bookmarksDelete = deletes
		plan.changes = append(plan.changes, changes...)
	}

	if parsed.LabelsFilePresent {
		current, err := s.store.ListAllLabelsByRepo(ctx, repository.ID)
		if err != nil {
			return syncPlan{}, fmt.Errorf("list labels: %w", err)
		}
		create, update, del, changes, warnings, err := s.buildLabelChanges(ctx, repository.ID, current, parsed.Labels)
		if err != nil {
			return syncPlan{}, err
		}
		plan.labelsCreate = create
		plan.labelsUpdate = update
		plan.labelsDelete = del
		plan.changes = append(plan.changes, changes...)
		plan.warnings = append(plan.warnings, warnings...)
	}

	if parsed.WebhooksFilePresent {
		current, err := s.store.ListWebhooksByRepo(ctx, repository.ID)
		if err != nil {
			return syncPlan{}, fmt.Errorf("list webhooks: %w", err)
		}
		create, update, del, changes, err := s.buildWebhookChanges(ctx, repository.ID, current, parsed.Webhooks)
		if err != nil {
			return syncPlan{}, err
		}
		plan.webhooksCreate = create
		plan.webhooksUpdate = update
		plan.webhooksDelete = del
		plan.changes = append(plan.changes, changes...)
	}

	return plan, nil
}

func buildRepoUpdate(repository db.Repository, cfg ConfigFile) (*db.UpdateRepoConfigStateParams, []Change) {
	current := repoConfigSnapshotFromRepository(repository)
	desired := current
	var changes []Change

	if cfg.Repository != nil {
		if cfg.Repository.Description != nil && desired.Description != *cfg.Repository.Description {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "repository.description",
				Action:     "update",
				Before:     desired.Description,
				After:      *cfg.Repository.Description,
			})
			desired.Description = *cfg.Repository.Description
		}
		if cfg.Repository.Visibility != nil {
			isPublic := *cfg.Repository.Visibility == "public"
			if desired.IsPublic != isPublic {
				changes = append(changes, Change{
					ConfigType: "config",
					Identifier: "repository.visibility",
					Action:     "update",
					Before:     visibilityLabel(desired.IsPublic),
					After:      *cfg.Repository.Visibility,
				})
				desired.IsPublic = isPublic
			}
		}
		if cfg.Repository.Topics != nil && !slices.Equal(desired.Topics, cfg.Repository.Topics) {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "repository.topics",
				Action:     "update",
				Before:     desired.Topics,
				After:      cfg.Repository.Topics,
			})
			desired.Topics = cloneStrings(cfg.Repository.Topics)
		}
		if cfg.Repository.Mirror != nil {
			updatedMirrorEnabled := desired.IsMirror
			updatedMirrorDestination := desired.MirrorDestination
			if cfg.Repository.Mirror.Enabled != nil {
				updatedMirrorEnabled = *cfg.Repository.Mirror.Enabled
				if !updatedMirrorEnabled {
					updatedMirrorDestination = ""
				}
			}
			if cfg.Repository.Mirror.Destination != nil {
				updatedMirrorDestination = *cfg.Repository.Mirror.Destination
			}
			if desired.IsMirror != updatedMirrorEnabled || desired.MirrorDestination != updatedMirrorDestination {
				changes = append(changes, Change{
					ConfigType: "config",
					Identifier: "repository.mirror",
					Action:     "update",
					Before: map[string]any{
						"enabled":     desired.IsMirror,
						"destination": desired.MirrorDestination,
					},
					After: map[string]any{
						"enabled":     updatedMirrorEnabled,
						"destination": updatedMirrorDestination,
					},
				})
				desired.IsMirror = updatedMirrorEnabled
				desired.MirrorDestination = updatedMirrorDestination
			}
		}
	}

	if cfg.Workspace != nil {
		if cfg.Workspace.IdleTimeoutSeconds != nil && desired.WorkspaceIdleTimeoutSecs != int32(*cfg.Workspace.IdleTimeoutSeconds) {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "workspace.idle_timeout_seconds",
				Action:     "update",
				Before:     desired.WorkspaceIdleTimeoutSecs,
				After:      *cfg.Workspace.IdleTimeoutSeconds,
			})
			desired.WorkspaceIdleTimeoutSecs = int32(*cfg.Workspace.IdleTimeoutSeconds)
		}
		if cfg.Workspace.Persistence != nil && desired.WorkspacePersistence != *cfg.Workspace.Persistence {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "workspace.persistence",
				Action:     "update",
				Before:     desired.WorkspacePersistence,
				After:      *cfg.Workspace.Persistence,
			})
			desired.WorkspacePersistence = *cfg.Workspace.Persistence
		}
		if cfg.Workspace.Dependencies != nil && !slices.Equal(desired.WorkspaceDependencies, cfg.Workspace.Dependencies) {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "workspace.dependencies",
				Action:     "update",
				Before:     desired.WorkspaceDependencies,
				After:      cfg.Workspace.Dependencies,
			})
			desired.WorkspaceDependencies = cloneStrings(cfg.Workspace.Dependencies)
		}
	}

	if cfg.LandingQueue != nil {
		if cfg.LandingQueue.Mode != nil && desired.LandingQueueMode != *cfg.LandingQueue.Mode {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "landing_queue.mode",
				Action:     "update",
				Before:     desired.LandingQueueMode,
				After:      *cfg.LandingQueue.Mode,
			})
			desired.LandingQueueMode = *cfg.LandingQueue.Mode
		}
		if cfg.LandingQueue.RequiredChecks != nil && !slices.Equal(desired.LandingQueueRequiredChecks, cfg.LandingQueue.RequiredChecks) {
			changes = append(changes, Change{
				ConfigType: "config",
				Identifier: "landing_queue.required_checks",
				Action:     "update",
				Before:     desired.LandingQueueRequiredChecks,
				After:      cfg.LandingQueue.RequiredChecks,
			})
			desired.LandingQueueRequiredChecks = cloneStrings(cfg.LandingQueue.RequiredChecks)
		}
	}

	if len(changes) == 0 {
		return nil, nil
	}

	return &db.UpdateRepoConfigStateParams{
		ID:                         repository.ID,
		Description:                desired.Description,
		IsPublic:                   desired.IsPublic,
		Topics:                     desired.Topics,
		IsMirror:                   desired.IsMirror,
		MirrorDestination:          desired.MirrorDestination,
		WorkspaceIdleTimeoutSecs:   desired.WorkspaceIdleTimeoutSecs,
		WorkspacePersistence:       desired.WorkspacePersistence,
		WorkspaceDependencies:      desired.WorkspaceDependencies,
		LandingQueueMode:           desired.LandingQueueMode,
		LandingQueueRequiredChecks: desired.LandingQueueRequiredChecks,
	}, changes
}

func buildProtectedBookmarkChanges(repositoryID int64, current []db.ProtectedBookmark, desired []ProtectedBookmarkRule) ([]db.UpsertProtectedBookmarkParams, []db.DeleteProtectedBookmarkByPatternParams, []Change) {
	currentByPattern := make(map[string]db.ProtectedBookmark, len(current))
	for _, bookmark := range current {
		currentByPattern[bookmark.Pattern] = bookmark
	}

	upsert := make([]db.UpsertProtectedBookmarkParams, 0, len(desired))
	changes := make([]Change, 0, len(desired))
	for _, bookmark := range desired {
		existing, exists := currentByPattern[bookmark.Pattern]
		if exists && protectedBookmarkEqual(existing, bookmark) {
			delete(currentByPattern, bookmark.Pattern)
			continue
		}

		upsert = append(upsert, db.UpsertProtectedBookmarkParams{
			RepositoryID:          repositoryID,
			Pattern:               bookmark.Pattern,
			RequireReview:         bookmark.RequireReview,
			RequireHumanApprovals: bookmark.RequireHumanApprovals,
			RequireAgentLgtm:      bookmark.RequireAgentLGTM,
			RequiredChecks:        bookmark.RequiredChecks,
			DismissStaleReviews:   bookmark.DismissStaleReviews,
			RestrictPushTeams:     bookmark.RestrictPushTeams,
		})

		action := "create"
		var before any
		if exists {
			action = "update"
			before = protectedBookmarkState(existing)
			delete(currentByPattern, bookmark.Pattern)
		}
		changes = append(changes, Change{
			ConfigType: "protected_bookmarks",
			Identifier: bookmark.Pattern,
			Action:     action,
			Before:     before,
			After:      protectedBookmarkRuleState(bookmark),
		})
	}

	deletes := make([]db.DeleteProtectedBookmarkByPatternParams, 0, len(currentByPattern))
	for pattern, bookmark := range currentByPattern {
		deletes = append(deletes, db.DeleteProtectedBookmarkByPatternParams{
			RepositoryID: repositoryID,
			Pattern:      pattern,
		})
		changes = append(changes, Change{
			ConfigType: "protected_bookmarks",
			Identifier: pattern,
			Action:     "delete",
			Before:     protectedBookmarkState(bookmark),
		})
	}

	return upsert, deletes, changes
}

func (s *Service) buildLabelChanges(ctx context.Context, repositoryID int64, current []db.Label, desired []LabelDefinition) ([]db.CreateLabelParams, []db.UpdateLabelParams, []db.DeleteLabelParams, []Change, []SyncWarning, error) {
	currentByName := make(map[string]db.Label, len(current))
	for _, label := range current {
		currentByName[label.Name] = label
	}

	create := make([]db.CreateLabelParams, 0, len(desired))
	update := make([]db.UpdateLabelParams, 0, len(desired))
	changes := make([]Change, 0, len(desired))
	for _, label := range desired {
		existing, exists := currentByName[label.Name]
		if exists && existing.Color == label.Color && existing.Description == label.Description {
			delete(currentByName, label.Name)
			continue
		}
		if exists {
			update = append(update, db.UpdateLabelParams{
				RepositoryID: repositoryID,
				ID:           existing.ID,
				Name:         label.Name,
				Color:        label.Color,
				Description:  label.Description,
			})
			changes = append(changes, Change{
				ConfigType: "labels",
				Identifier: label.Name,
				Action:     "update",
				Before:     labelState(existing),
				After:      labelDefinitionState(label),
			})
			delete(currentByName, label.Name)
			continue
		}

		create = append(create, db.CreateLabelParams{
			RepositoryID: repositoryID,
			Name:         label.Name,
			Color:        label.Color,
			Description:  label.Description,
		})
		changes = append(changes, Change{
			ConfigType: "labels",
			Identifier: label.Name,
			Action:     "create",
			After:      labelDefinitionState(label),
		})
	}

	deletes := make([]db.DeleteLabelParams, 0, len(currentByName))
	warnings := make([]SyncWarning, 0, len(currentByName))
	for name, label := range currentByName {
		refCount, err := s.store.CountIssueLabelsByLabel(ctx, label.ID)
		if err != nil {
			return nil, nil, nil, nil, nil, fmt.Errorf("count label references for %s: %w", name, err)
		}
		if refCount > 0 {
			warnings = append(warnings, SyncWarning{
				ConfigType: "labels",
				Identifier: name,
				Message:    "label is still attached to issues and was left in place",
			})
			continue
		}
		deletes = append(deletes, db.DeleteLabelParams{
			RepositoryID: repositoryID,
			ID:           label.ID,
		})
		changes = append(changes, Change{
			ConfigType: "labels",
			Identifier: name,
			Action:     "delete",
			Before:     labelState(label),
		})
	}

	return create, update, deletes, changes, warnings, nil
}

func (s *Service) buildWebhookChanges(ctx context.Context, repositoryID int64, current []db.Webhook, desired []WebhookDefinition) ([]db.CreateWebhookParams, []db.UpdateWebhookByIDParams, []db.DeleteWebhookByIDParams, []Change, error) {
	currentByURL := make(map[string]db.Webhook, len(current))
	for _, hook := range current {
		currentByURL[hook.Url] = hook
	}

	create := make([]db.CreateWebhookParams, 0, len(desired))
	update := make([]db.UpdateWebhookByIDParams, 0, len(desired))
	changes := make([]Change, 0, len(desired))
	for _, hook := range desired {
		resolvedSecret, err := s.resolveSecretReference(ctx, repositoryID, hook.SecretRef)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		encryptedSecret, err := s.secretCodec.EncryptString(resolvedSecret)
		if err != nil {
			return nil, nil, nil, nil, fmt.Errorf("encrypt webhook secret for %s: %w", hook.URL, err)
		}

		existing, exists := currentByURL[hook.URL]
		if exists {
			existingSecret, err := s.secretCodec.DecryptString(existing.Secret)
			if err != nil {
				return nil, nil, nil, nil, fmt.Errorf("decrypt existing webhook secret for %s: %w", hook.URL, err)
			}
			if existingSecret == resolvedSecret && existing.IsActive == hook.Active && slices.Equal(existing.Events, hook.Events) {
				delete(currentByURL, hook.URL)
				continue
			}
			update = append(update, db.UpdateWebhookByIDParams{
				RepositoryID: repositoryID,
				ID:           existing.ID,
				Url:          hook.URL,
				Secret:       encryptedSecret,
				Events:       hook.Events,
				IsActive:     hook.Active,
			})
			changes = append(changes, Change{
				ConfigType: "webhooks",
				Identifier: hook.URL,
				Action:     "update",
				Before:     webhookState(existing),
				After:      webhookDefinitionState(hook),
			})
			delete(currentByURL, hook.URL)
			continue
		}

		create = append(create, db.CreateWebhookParams{
			RepositoryID: repositoryID,
			Url:          hook.URL,
			Secret:       encryptedSecret,
			Events:       hook.Events,
			IsActive:     hook.Active,
		})
		changes = append(changes, Change{
			ConfigType: "webhooks",
			Identifier: hook.URL,
			Action:     "create",
			After:      webhookDefinitionState(hook),
		})
	}

	deletes := make([]db.DeleteWebhookByIDParams, 0, len(currentByURL))
	for urlValue, hook := range currentByURL {
		deletes = append(deletes, db.DeleteWebhookByIDParams{
			RepositoryID: repositoryID,
			ID:           hook.ID,
		})
		changes = append(changes, Change{
			ConfigType: "webhooks",
			Identifier: urlValue,
			Action:     "delete",
			Before:     webhookState(hook),
		})
	}

	return create, update, deletes, changes, nil
}

func applyPlan(ctx context.Context, store Store, plan syncPlan) error {
	if plan.repoUpdate != nil {
		if _, err := store.UpdateRepoConfigState(ctx, *plan.repoUpdate); err != nil {
			return fmt.Errorf("update repository config: %w", err)
		}
	}

	for _, arg := range plan.bookmarksUpsert {
		if _, err := store.UpsertProtectedBookmark(ctx, arg); err != nil {
			return fmt.Errorf("upsert protected bookmark %s: %w", arg.Pattern, err)
		}
	}
	for _, arg := range plan.bookmarksDelete {
		if _, err := store.DeleteProtectedBookmarkByPattern(ctx, arg); err != nil {
			return fmt.Errorf("delete protected bookmark %s: %w", arg.Pattern, err)
		}
	}

	for _, arg := range plan.labelsCreate {
		if _, err := store.CreateLabel(ctx, arg); err != nil {
			return fmt.Errorf("create label %s: %w", arg.Name, err)
		}
	}
	for _, arg := range plan.labelsUpdate {
		if _, err := store.UpdateLabel(ctx, arg); err != nil {
			return fmt.Errorf("update label %s: %w", arg.Name, err)
		}
	}
	for _, arg := range plan.labelsDelete {
		if err := store.DeleteLabel(ctx, arg); err != nil {
			return fmt.Errorf("delete label %d: %w", arg.ID, err)
		}
	}

	for _, arg := range plan.webhooksCreate {
		if _, err := store.CreateWebhook(ctx, arg); err != nil {
			return fmt.Errorf("create webhook %s: %w", arg.Url, err)
		}
	}
	for _, arg := range plan.webhooksUpdate {
		if _, err := store.UpdateWebhookByID(ctx, arg); err != nil {
			return fmt.Errorf("update webhook %s: %w", arg.Url, err)
		}
	}
	for _, arg := range plan.webhooksDelete {
		if err := store.DeleteWebhookByID(ctx, arg); err != nil {
			return fmt.Errorf("delete webhook %d: %w", arg.ID, err)
		}
	}

	return nil
}

func (s *Service) resolveSecretReference(ctx context.Context, repositoryID int64, expression string) (string, error) {
	if strings.TrimSpace(expression) == "" {
		return "", nil
	}

	matches := secretRefPattern.FindStringSubmatch(expression)
	if len(matches) != 2 {
		return "", fmt.Errorf("webhook secret reference %q is invalid", expression)
	}

	encrypted, err := s.store.GetSecretValueByName(ctx, db.GetSecretValueByNameParams{
		RepositoryID: repositoryID,
		Name:         matches[1],
	})
	if err != nil {
		return "", fmt.Errorf("resolve repository secret %s: %w", matches[1], err)
	}
	return s.secretCodec.DecryptString(string(encrypted))
}

func (s *Service) resolveRepoOwner(ctx context.Context, repository db.Repository) (string, error) {
	if repository.UserID.Valid {
		user, err := s.store.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner user: %w", err)
		}
		return user.Username, nil
	}
	if repository.OrgID.Valid {
		org, err := s.store.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner org: %w", err)
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("repository %d has no owner namespace", repository.ID)
}

func repoConfigSnapshotFromRepository(repository db.Repository) repoConfigSnapshot {
	return repoConfigSnapshot{
		Description:                repository.Description,
		IsPublic:                   repository.IsPublic,
		Topics:                     cloneStrings(repository.Topics),
		IsMirror:                   repository.IsMirror,
		MirrorDestination:          repository.MirrorDestination,
		WorkspaceIdleTimeoutSecs:   repository.WorkspaceIdleTimeoutSecs,
		WorkspacePersistence:       repository.WorkspacePersistence,
		WorkspaceDependencies:      cloneStrings(repository.WorkspaceDependencies),
		LandingQueueMode:           repository.LandingQueueMode,
		LandingQueueRequiredChecks: cloneStrings(repository.LandingQueueRequiredChecks),
	}
}

func protectedBookmarkEqual(current db.ProtectedBookmark, desired ProtectedBookmarkRule) bool {
	return current.RequireReview == desired.RequireReview &&
		current.RequireHumanApprovals == desired.RequireHumanApprovals &&
		current.RequireAgentLgtm == desired.RequireAgentLGTM &&
		current.DismissStaleReviews == desired.DismissStaleReviews &&
		slices.Equal(current.RequiredChecks, desired.RequiredChecks) &&
		slices.Equal(current.RestrictPushTeams, desired.RestrictPushTeams)
}

func visibilityLabel(isPublic bool) string {
	if isPublic {
		return "public"
	}
	return "private"
}

func filesProcessed(parsed ParsedConfig) []string {
	result := make([]string, 0, 4)
	if parsed.ConfigFilePresent {
		result = append(result, configFilePath)
	}
	if parsed.ProtectedBookmarksFilePresent {
		result = append(result, protectedBookmarksFilePath)
	}
	if parsed.LabelsFilePresent {
		result = append(result, labelsFilePath)
	}
	if parsed.WebhooksFilePresent {
		result = append(result, webhooksFilePath)
	}
	return result
}

func cloneStrings(values []string) []string {
	if values == nil {
		return nil
	}
	if len(values) == 0 {
		return []string{}
	}
	return append([]string(nil), values...)
}

func protectedBookmarkState(bookmark db.ProtectedBookmark) map[string]any {
	return map[string]any{
		"require_review":          bookmark.RequireReview,
		"require_human_approvals": bookmark.RequireHumanApprovals,
		"require_agent_lgtm":      bookmark.RequireAgentLgtm,
		"required_checks":         cloneStrings(bookmark.RequiredChecks),
		"dismiss_stale_reviews":   bookmark.DismissStaleReviews,
		"restrict_push_teams":     cloneStrings(bookmark.RestrictPushTeams),
	}
}

func protectedBookmarkRuleState(bookmark ProtectedBookmarkRule) map[string]any {
	return map[string]any{
		"require_review":          bookmark.RequireReview,
		"require_human_approvals": bookmark.RequireHumanApprovals,
		"require_agent_lgtm":      bookmark.RequireAgentLGTM,
		"required_checks":         cloneStrings(bookmark.RequiredChecks),
		"dismiss_stale_reviews":   bookmark.DismissStaleReviews,
		"restrict_push_teams":     cloneStrings(bookmark.RestrictPushTeams),
	}
}

func labelState(label db.Label) map[string]any {
	return map[string]any{
		"color":       label.Color,
		"description": label.Description,
	}
}

func labelDefinitionState(label LabelDefinition) map[string]any {
	return map[string]any{
		"color":       label.Color,
		"description": label.Description,
	}
}

func webhookState(webhookRecord db.Webhook) map[string]any {
	return map[string]any{
		"events":     cloneStrings(webhookRecord.Events),
		"active":     webhookRecord.IsActive,
		"has_secret": strings.TrimSpace(webhookRecord.Secret) != "",
	}
}

func webhookDefinitionState(webhookDef WebhookDefinition) map[string]any {
	return map[string]any{
		"events":     cloneStrings(webhookDef.Events),
		"active":     webhookDef.Active,
		"secret_ref": webhookDef.SecretRef,
	}
}

func (s *Service) logAuditEvents(ctx context.Context, input SyncInput, repoName string, result SyncResult) {
	if s.audit == nil || len(result.Changes) == 0 {
		return
	}

	actorName := strings.TrimSpace(input.ActorName)
	if actorName == "" {
		actorName = "system"
	}

	targetID := input.RepositoryID
	action := "apply"
	if input.DryRun {
		action = "dry_run"
	}

	for _, change := range result.Changes {
		s.audit.Log(ctx, services.AuditEvent{
			EventType:  "config.sync",
			ActorID:    input.ActorID,
			ActorName:  actorName,
			TargetType: change.ConfigType,
			TargetID:   &targetID,
			TargetName: repoName,
			Action:     action,
			Metadata: map[string]any{
				"commit_sha":      input.CommitSHA,
				"triggered_by":    input.Trigger,
				"identifier":      change.Identifier,
				"change_action":   change.Action,
				"before":          change.Before,
				"after":           change.After,
				"files_processed": result.FilesProcessed,
			},
			IPAddress: input.IPAddress,
		})
	}
}

func (s *Service) logFailure(ctx context.Context, input SyncInput, err error, repoName string) {
	if s.audit == nil {
		return
	}

	actorName := strings.TrimSpace(input.ActorName)
	if actorName == "" {
		actorName = "system"
	}

	targetID := pgtype.Int8{Int64: input.RepositoryID, Valid: input.RepositoryID > 0}
	var targetIDPtr *int64
	if targetID.Valid {
		targetIDPtr = &targetID.Int64
	}

	s.audit.Log(ctx, services.AuditEvent{
		EventType:  "config.sync",
		ActorID:    input.ActorID,
		ActorName:  actorName,
		TargetType: "repository",
		TargetID:   targetIDPtr,
		TargetName: repoName,
		Action:     "failed",
		Metadata: map[string]any{
			"commit_sha":   input.CommitSHA,
			"triggered_by": input.Trigger,
			"error":        err.Error(),
		},
		IPAddress: input.IPAddress,
	})
}
