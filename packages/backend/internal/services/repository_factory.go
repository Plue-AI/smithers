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
	} `json:"on"`
	Github struct {
		Maintainers []string `json:"maintainers"`
	} `json:"github"`
	// gitHubAccount returns the ID of the GitHub account holding a login now,
	// or "" when none does, so a login a renamed account left behind approves
	// nothing. The GitHub main pull sets it; logins resolve lazily, in order.
	gitHubAccount func(login string) (string, error)
}

// FactoryRulesUnapprovedError is why an organization repository's factory
// rules are not registered: no committed maintainer resolves to a Cloud user
// who can approve them. Missing names each maintainer's missing link.
type FactoryRulesUnapprovedError struct{ Missing []string }

func (e *FactoryRulesUnapprovedError) Error() string {
	if len(e.Missing) == 0 {
		return "factory rules not registered: " + gitHubMainPullFactoryPath + " names no maintainers to approve them"
	}
	return "factory rules not registered: no maintainer can approve them (" + strings.Join(e.Missing, "; ") + ")"
}

// factoryApprover is the Cloud user factory rules run as, and that user's
// workspace. A user's repository is its owner's. An organization's is the
// first committed maintainer, in declaration order, whose GitHub account is
// linked to a Cloud user with write access and a workspace; write access
// alone never approves.
func factoryApprover(ctx context.Context, tx db.DBTX, q *db.Queries, repo db.Repository, projection FactoryProjection) (int64, db.Workspace, error) {
	if repo.UserID.Valid {
		workspace, err := q.GetActiveWorkspaceForUserRepo(ctx, db.GetActiveWorkspaceForUserRepoParams{RepositoryID: repo.ID, UserID: repo.UserID.Int64})
		if err != nil {
			return 0, workspace, fmt.Errorf("factory needs the owner's workspace: %w", err)
		}
		return repo.UserID.Int64, workspace, nil
	}
	unapproved := &FactoryRulesUnapprovedError{}
	for _, login := range projection.Github.Maintainers {
		login = strings.TrimSpace(login)
		if projection.gitHubAccount == nil {
			unapproved.Missing = append(unapproved.Missing, login+": only a GitHub main pull resolves maintainers")
			continue
		}
		account, err := projection.gitHubAccount(login)
		if err != nil {
			// A failed lookup approves nothing, so it still revokes.
			unapproved.Missing = append(unapproved.Missing, login+": GitHub lookup failed: "+err.Error())
			continue
		}
		if account == "" {
			unapproved.Missing = append(unapproved.Missing, login+": no GitHub account holds this login")
			continue
		}
		// GitHub sign-in stores the account ID under "workos" or "auth0"
		// (auth.go; Auth0's github|<id>, other subjects hash to 63 bits), a
		// GitHub connection under "github".
		rows, err := tx.Query(ctx, `SELECT o.user_id FROM oauth_accounts o JOIN users u ON u.id = o.user_id
			WHERE o.provider IN ('github', 'workos', 'auth0') AND o.provider_user_id = $1
			  AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL ORDER BY o.user_id`, account)
		if err != nil {
			return 0, db.Workspace{}, err
		}
		users, err := pgx.CollectRows(rows, pgx.RowTo[int64])
		if err != nil {
			return 0, db.Workspace{}, err
		}
		reason := login + ": no Cloud user is linked to this GitHub account"
		for _, user := range users {
			if ok, err := canWriteRepo(ctx, q, repo, user); err != nil {
				return 0, db.Workspace{}, err
			} else if !ok {
				reason = login + ": the linked Cloud user has no write access"
				continue
			}
			workspace, err := q.GetActiveWorkspaceForUserRepo(ctx, db.GetActiveWorkspaceForUserRepoParams{RepositoryID: repo.ID, UserID: user})
			if errors.Is(err, pgx.ErrNoRows) {
				reason = login + ": the linked Cloud user has no workspace for this repository"
				continue
			}
			if err != nil {
				return 0, db.Workspace{}, err
			}
			return user, workspace, nil
		}
		unapproved.Missing = append(unapproved.Missing, reason)
	}
	return 0, db.Workspace{}, unapproved
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

// ReconcileFactoryRules runs only after a repository's main is verified at
// revision; factoryApprover names the user its rules run as. The transaction serializes reconciliation and retires removed
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
	if lookup := projection.gitHubAccount; len(rules) > 0 && lookup != nil {
		// Look maintainers up once, before any lock: the locked pass below
		// reuses the answers, and calls GitHub only for a login the first pass
		// never reached (its approver lost access in between).
		type answer struct {
			account string
			err     error
		}
		answers := map[string]answer{}
		projection.gitHubAccount = func(login string) (string, error) {
			a, ok := answers[login]
			if !ok {
				a.account, a.err = lookup(login)
				answers[login] = a
			}
			return a.account, a.err
		}
		pre, err := s.transactions.Begin(ctx)
		if err != nil {
			return err
		}
		if repo, err := db.New(pre).GetRepoByID(ctx, repoID); err == nil {
			_, _, _ = factoryApprover(ctx, pre, db.New(pre), repo, projection)
		}
		_ = pre.Rollback(ctx)
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
	var approver int64
	var workspace db.Workspace
	var unapproved *FactoryRulesUnapprovedError
	if len(rules) > 0 {
		approver, workspace, err = factoryApprover(ctx, tx, q, repo, projection)
		if errors.As(err, &unapproved) {
			// No maintainer approves: every factory rule pauses, so a removed
			// maintainer's registrations never keep running as them.
			rules = nil
		} else if err != nil {
			return err
		}
	}
	// Read the rules locked: a person's pause either lands before this read
	// or waits for this decision. Enabled rows in job order, as
	// RegisterRepositoryJob locks a job's enabled row before its trial row.
	if _, err = tx.Exec(ctx, `SELECT 1 FROM repository_job_registrations WHERE repository_id = $1 AND mode = 'enabled'
		ORDER BY job FOR NO KEY UPDATE`, repoID); err != nil {
		return err
	}
	existing, err := q.ListRepositoryJobRegistrations(ctx, repoID)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	if len(rules) > 0 {
		for _, rule := range rules {
			keep[rule.job] = true
			input := rule.input
			input.WorkspaceID = workspace.ID
			input.Revision = 1
			unchanged := false
			for _, old := range existing {
				if old.Job == rule.job && old.Mode == "enabled" {
					input.Revision = old.Revision + 1
					// A person's pause holds until main moves, whoever
					// approves; a refusal's pause ends with the refusal.
					var mark struct {
						Unapproved bool `json:"factory_unapproved"`
					}
					_ = json.Unmarshal(old.Configuration, &mark)
					unchanged = old.Digest == input.Digest && (!old.Enabled && !mark.Unapproved || old.Enabled && old.WorkspaceID == workspace.ID && old.UserID == approver)
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
			_, err = q.RegisterRepositoryJob(ctx, db.RegisterRepositoryJobParams{RepositoryID: repoID, WorkspaceID: workspace.ID, UserID: approver, Job: rule.job, Mode: "enabled", Revision: input.Revision, Digest: input.Digest, SourceRevision: revision, FlowID: input.FlowID, Configuration: configuration, Schedule: input.Schedule, NextFireAt: next})
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
			// Mark a rule the refusal pauses, so approval re-enables it. The
			// row's current enabled decides, so a person's pause committed
			// first is never marked; PauseRepositoryJob strips the mark.
			if unapproved != nil {
				if _, err = tx.Exec(ctx, `UPDATE repository_job_registrations SET configuration = configuration || '{"factory_unapproved":true}'
					WHERE repository_id = $1 AND job = $2 AND mode = $3 AND enabled`, repoID, old.Job, old.Mode); err != nil {
					return err
				}
			}
			// PauseRepositoryJob's scope, keeping the mark.
			if _, err = tx.Exec(ctx, `UPDATE repository_job_registrations SET enabled = false, updated_at = now()
				WHERE repository_id = $1 AND job = $2`, repoID, old.Job); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if unapproved != nil {
		return unapproved
	}
	return nil
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
