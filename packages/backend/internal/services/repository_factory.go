package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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

// ReconcileFactoryRules runs only after an owner repository's main is verified
// at revision. The transaction serializes reconciliation and retires removed
// rules; retries of identical source/configuration never reactivate paused rows.
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
	if !repo.UserID.Valid {
		if len(rules) == 0 {
			return tx.Commit(ctx)
		}
		return errors.New("factory auto-approval requires an owner repository")
	}
	existing, err := q.ListRepositoryJobRegistrations(ctx, repoID)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	if len(rules) > 0 {
		workspace, err := q.GetActiveWorkspaceForUserRepo(ctx, db.GetActiveWorkspaceForUserRepoParams{RepositoryID: repoID, UserID: repo.UserID.Int64})
		if err != nil {
			return fmt.Errorf("factory needs the owner's workspace: %w", err)
		}
		for _, rule := range rules {
			keep[rule.job] = true
			input := rule.input
			input.WorkspaceID = workspace.ID
			input.Revision = 1
			unchanged := false
			for _, old := range existing {
				if old.Job == rule.job && old.Mode == "enabled" {
					input.Revision = old.Revision + 1
					unchanged = old.Digest == input.Digest && old.WorkspaceID == workspace.ID
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
			_, err = q.RegisterRepositoryJob(ctx, db.RegisterRepositoryJobParams{RepositoryID: repoID, WorkspaceID: workspace.ID, UserID: repo.UserID.Int64, Job: rule.job, Mode: "enabled", Revision: input.Revision, Digest: input.Digest, SourceRevision: revision, FlowID: input.FlowID, Configuration: configuration, Schedule: input.Schedule, NextFireAt: next})
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
		if input.FactoryRevision != "" && !keep[old.Job] {
			if _, err = q.PauseRepositoryJob(ctx, db.PauseRepositoryJobParams{RepositoryID: repoID, Job: old.Job}); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
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
