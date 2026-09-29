package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// FactoryProjection is committed data, never executable FACTORY.ts. Budget and
// child-flow metadata come from discovery; old projections remain declared-only.
type FactoryProjection struct {
	Flows []struct {
		ID           string          `json:"id"`
		Kind         string          `json:"kind"`
		Capabilities []string        `json:"capabilities"`
		Flows        []string        `json:"flows"`
		Budget       json.RawMessage `json:"budget"`
	} `json:"flows"`
	On []struct {
		Event string          `json:"event"`
		Flow  json.RawMessage `json:"flow"`
		// Presence is rejected, including null: execution is repository-local.
		Repository json.RawMessage `json:"repository,omitempty"`
	} `json:"on"`
}

type factoryRegistration struct {
	job   string
	input RegisterRepositoryJobInput
}

func factoryRegistrations(projection FactoryProjection, revision string) ([]factoryRegistration, error) {
	var result []factoryRegistration
	seen := map[string]bool{}
	for _, rule := range projection.On {
		if rule.Repository != nil {
			return nil, errors.New("factory rules cannot select a repository; declare the flow in the target repository's factory")
		}
		var names []string
		var name string
		if json.Unmarshal(rule.Flow, &name) == nil {
			names = []string{name}
		} else if json.Unmarshal(rule.Flow, &names) != nil {
			return nil, errors.New("factory rule has invalid flow names")
		}
		for _, name := range names {
			for _, flow := range projection.Flows {
				if flow.ID != name {
					continue
				}
				// Prompt flows have a complete declarative envelope. Module-backed flows
				// need executable registration; never invent an envelope for one.
				if flow.Kind != "mdx" || flow.Budget == nil || flow.Capabilities == nil || flow.Flows == nil {
					continue
				}
				input := RegisterRepositoryJobInput{FlowID: name, Mode: "enabled", SourceRevision: revision, FactoryRevision: revision, Input: json.RawMessage(`{}`)}
				if strings.HasPrefix(rule.Event, "schedule:") {
					input.Schedule = strings.TrimPrefix(rule.Event, "schedule:")
				} else {
					kind, action, _ := strings.Cut(rule.Event, ".")
					switch NormalizeTriggerName(kind) {
					case "issue", "issue_comment", "pull_request", "pull_request_review", "push", "check_run", "check_suite":
					default:
						continue
					}
					event := RepositoryJobEventRule{Type: NormalizeTriggerName(kind)}
					if action != "" {
						action, input.Label, _ = strings.Cut(action, ":")
						event.Actions = []string{action}
					}
					input.Events = []RepositoryJobEventRule{event}
					// issue.assigned:@login and issue_comment.created:@login
					// select by the login assigned or mentioned, never a label.
					if mention, ok := strings.CutPrefix(input.Label, "@"); ok {
						input.Label, input.Mention = "", strings.ToLower(mention)
						if !repositoryJobMentionRule(input.Mention, input.Events) {
							return nil, fmt.Errorf("factory rule %s: a mention applies only to issue.assigned or issue_comment.created", rule.Event)
						}
					}
				}
				input.Envelope, _ = json.Marshal(map[string]any{"capabilities": flow.Capabilities, "flows": flow.Flows, "budget": flow.Budget})
				if err := validateRepositoryJobEnvelope(input.Envelope); err != nil {
					return nil, fmt.Errorf("factory flow %s: %w", name, err)
				}
				sum := sha256.Sum256([]byte(rule.Event + "\x00" + name))
				job := "flow:factory-" + hex.EncodeToString(sum[:16])
				if seen[job] {
					return nil, fmt.Errorf("duplicate factory rule for %s", name)
				}
				seen[job] = true
				material, _ := json.Marshal(input)
				digest := sha256.Sum256(material)
				input.Digest = hex.EncodeToString(digest[:])
				result = append(result, factoryRegistration{job, input})
			}
		}
	}
	return result, nil
}

// ErrFactoryNeedsOwner means declared rules have no configured execution owner.
// Reconciliation still retires old factory registrations before returning it.
var ErrFactoryNeedsOwner = errors.New("factory rules need a configured organization owner")

// ErrFactoryNeedsWorkspace is retryable once the configured owner has a workspace.
var ErrFactoryNeedsWorkspace = errors.New("factory needs the owner's workspace")

// ReconcileFactoryRules runs after repository main is verified at revision.
// It serializes reconciliation and retires removed rules; retries of identical
// source/configuration never reactivate paused rows.
func (s *RepositoryJobService) ReconcileFactoryRules(ctx context.Context, repoID int64, revision string, projection FactoryProjection) error {
	if !isImmutableGitObjectID(revision) {
		return errors.New("factory requires an immutable main revision")
	}
	rules, err := factoryRegistrations(projection, revision)
	if err != nil {
		return err
	}
	if s.transactions == nil {
		return errors.New("factory reconciliation requires transactions")
	}
	tx, err := s.transactions.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Same ownership fence as registration, plus one writer per repository.
	if _, err = tx.Exec(ctx, repoOwnershipSharedLockSQL, repoID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repoID); err != nil {
		return err
	}
	q := db.New(tx)
	repo, err := q.GetRepoByID(ctx, repoID)
	if err != nil {
		return err
	}
	ownerID := repo.UserID
	if !ownerID.Valid && repo.OrgID.Valid {
		// Serialize configuration and membership changes with reconciliation.
		if _, err := q.LockOrganization(ctx, repo.OrgID.Int64); err != nil {
			return err
		}
		org, err := q.GetOrgByID(ctx, repo.OrgID.Int64)
		if err != nil {
			return err
		}
		ownerID = org.FactoryOwnerID
		if ownerID.Valid {
			member, err := q.GetOrgMember(ctx, db.GetOrgMemberParams{OrganizationID: org.ID, UserID: ownerID.Int64})
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if errors.Is(err, pgx.ErrNoRows) || member.Role != "owner" {
				ownerID.Valid = false
			}
		}
		if ownerID.Valid {
			owner, err := q.GetUserByIDNotDeleted(ctx, ownerID.Int64)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			if errors.Is(err, pgx.ErrNoRows) || !owner.IsActive || owner.ProhibitLogin {
				ownerID.Valid = false
			}
		}
	}
	declaredWithoutOwner := !ownerID.Valid && len(rules) > 0
	if !ownerID.Valid {
		rules = nil
	}
	// A person's pause updates these same rows. Lock before reading its state so
	// neither suspension nor recovery can overwrite a concurrent pause using a
	// stale enabled flag or automatic-suspension marker.
	if _, err := tx.Exec(ctx, `SELECT id FROM repository_job_registrations WHERE repository_id=$1 ORDER BY id FOR UPDATE`, repoID); err != nil {
		return err
	}
	existing, err := q.ListRepositoryJobRegistrations(ctx, repoID)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	var workspace db.Workspace
	var workspaceError error
	if len(rules) > 0 {
		workspace, err = q.GetActiveWorkspaceForUserRepo(ctx, db.GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: ownerID.Int64})
		if errors.Is(err, pgx.ErrNoRows) {
			workspaceError = fmt.Errorf("%w: %w", ErrFactoryNeedsWorkspace, err)
		} else if err != nil {
			return err
		}
	}
	if workspaceError == nil {
		for _, rule := range rules {
			keep[rule.job] = true
			input := rule.input
			input.WorkspaceID = workspace.ID
			input.Revision = 1
			unchanged := false
			for _, old := range existing {
				if old.Job == rule.job && old.Mode == "enabled" {
					input.Revision = old.Revision + 1
					var previous struct {
						OwnerSuspended bool `json:"factory_owner_suspended"`
					}
					if err := json.Unmarshal(old.Configuration, &previous); err != nil {
						return errors.New("invalid stored factory registration")
					}
					intentionallyPaused := !old.Enabled && !previous.OwnerSuspended
					sameOwnerWorkspace := old.WorkspaceID == workspace.ID && old.UserID == ownerID.Int64
					unchanged = old.Digest == input.Digest && !previous.OwnerSuspended && (intentionallyPaused || sameOwnerWorkspace)
				}
			}
			if unchanged {
				continue
			}
			next, err := validateRepositoryJob(rule.job, input, s.now())
			if err != nil {
				return err
			}
			configuration, err := json.Marshal(input)
			if err != nil {
				return err
			}
			_, err = q.RegisterRepositoryJob(ctx, db.RegisterRepositoryJobParams{RepositoryID: repoID, WorkspaceID: workspace.ID, UserID: ownerID.Int64, Job: rule.job, Mode: "enabled", Revision: input.Revision, Digest: input.Digest, SourceRevision: revision, FlowID: input.FlowID, Configuration: configuration, Schedule: input.Schedule, NextFireAt: next})
			if err != nil {
				return err
			}
		}
	}
	for _, old := range existing {
		var input RegisterRepositoryJobInput
		if json.Unmarshal(old.Configuration, &input) != nil {
			return errors.New("invalid stored factory registration")
		}
		if input.FactoryRevision == "" || keep[old.Job] {
			continue
		}
		// Missing execution prerequisites must stop obsolete owners immediately.
		// Preserve the distinction between automatic suspension and a person's pause.
		if old.Enabled {
			if _, err = tx.Exec(ctx, `UPDATE repository_job_registrations
				SET enabled=false, configuration=configuration || '{"factory_owner_suspended":true}'::jsonb, updated_at=now()
				WHERE id=$1`, old.ID); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if declaredWithoutOwner {
		return ErrFactoryNeedsOwner
	}
	return workspaceError
}

// reconcileLocalFactory reads committed data at the exact folded main. The stack
// worker already owns fetch/retry; local repositories need no GitHub mirror.
func (s *MythicalService) reconcileLocalFactory(ctx context.Context, r *mythicalRun) error {
	if !r.g.has(ctx, r.mainTip) {
		if err := r.g.fetch(ctx, r.bridge.URL(), 1, 0, "refs/heads/"+r.branch); err != nil {
			return fmt.Errorf("fetch main: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	// ls-tree distinguishes an absent file from a failed read. Absence retires
	// removed declarations; malformed data never silently retires live jobs.
	entry, err := r.g.git(ctx, "ls-tree", r.mainTip, "--", gitHubMainPullFactoryPath)
	if err != nil {
		return err
	}
	projection := FactoryProjection{}
	if entry != "" {
		if !strings.HasPrefix(entry, "100644 blob ") && !strings.HasPrefix(entry, "100755 blob ") {
			return errors.New("factory projection must be a regular file")
		}
		raw, err := r.g.command(ctx, nil, "show", r.mainTip+":"+gitHubMainPullFactoryPath)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &projection); err != nil {
			return errors.New("invalid factory projection")
		}
	}
	return s.reconcileFactory(ctx, r.row.RepositoryID, r.mainTip, projection)
}

// localFactoryOutcome keeps an injected reconciler's errors and panics from
// interrupting stack work, while retaining a separate durable receipt.
func (s *MythicalService) localFactoryOutcome(ctx context.Context, r *mythicalRun) (state, message string) {
	state = "failed"
	defer func() {
		if recovered := recover(); recovered != nil {
			state, message = "failed", "internal factory error"
			s.logger.ErrorContext(ctx, "mythical.factory_panic", "repository_id", r.row.RepositoryID, "panic", recovered)
		}
	}()
	err := s.reconcileLocalFactory(ctx, r)
	switch {
	case errors.Is(err, ErrFactoryNeedsOwner):
		return "skipped", err.Error()
	case err != nil:
		return "failed", sanitizeMirrorError(err, r.bridge.URL())
	default:
		return "reconciled", ""
	}
}
