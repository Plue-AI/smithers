package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// flow-load (engineering spec §11.3.1, T-FLW-03): after every main move the
// stack worker loads main's flows on a short-lived workspace. Loads
// coalesce: one runs at a time, and when it ends the next pass loads the
// newest main not yet loaded, so a main that moved twice during a load is
// loaded once. The run (flows/coding/flow-load) answers each overridable
// flow's version; settling it writes the versions and moves Active in one
// transaction (flow_versions.go). The stack's own MainMoved listener is the
// trigger: the pass that folds main is the pass after which this step sees
// the new main.
const (
	flowLoadFlow        = "flow-load"
	flowLoadBindingKind = "flow-load"
	flowLoadAttempts    = 3
	// A load reads files and imports modules: it is short.
	flowLoadTimeout      = 20 * time.Minute
	flowLoadStartTimeout = 15 * time.Minute
)

// SetFlowLoad turns flow-load on (SMITHERS_FEATURE_FLAGS_FLOW_LOAD). Off, no
// load runs and every flow keeps the Active version it has.
func (s *MythicalService) SetFlowLoad(enabled bool) { s.flowLoad = enabled }

type flowLoadProjection struct {
	Kind         string `json:"kind"`
	RepositoryID int64  `json:"repositoryId"`
	Generation   int64  `json:"generation"`
}

// advanceFlowLoad moves the repository's flow-load one step. The stack is
// current (its landed main is main's tip) when this runs.
func (s *MythicalService) advanceFlowLoad(ctx context.Context, r *mythicalRun) {
	if !s.flowLoad || s.launcher == nil || s.lanes == nil || !r.row.ActorUserID.Valid || !flowCommitPattern.MatchString(r.row.LandedMain) {
		return
	}
	if err := s.stepFlowLoad(ctx, r); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.flow_load_failed", "repository_id", r.row.RepositoryID, "error", err)
	}
}

func (s *MythicalService) stepFlowLoad(ctx context.Context, r *mythicalRun) error {
	q := s.queries()
	row, err := q.EnsureFlowLoad(ctx, r.row.RepositoryID)
	if err != nil {
		return err
	}
	now := s.now()
	if row.State == "running" {
		if err := s.settleFlowLoad(ctx, r, row, now); err != nil {
			return err
		}
		// A settled load makes way for the next at once: main may have
		// moved while it ran.
		if row, err = q.GetFlowLoad(ctx, r.row.RepositoryID); err != nil || row.State == "running" {
			return err
		}
	}
	// A launch that never started leaves its bound workspace behind.
	if row.WorkspaceID != "" {
		next := row
		if err := s.retireFlowLoadWorkspace(ctx, r, &next); err != nil {
			return err
		}
		return s.saveFlowLoad(ctx, r, next)
	}
	if row.LoadedCommit == r.row.LandedMain {
		return nil
	}
	attempt := row.Attempt
	if row.CommitID != r.row.LandedMain {
		attempt = 0
	}
	if attempt >= flowLoadAttempts || now.Before(row.NextAttemptAt) && row.CommitID == r.row.LandedMain {
		return nil
	}
	return s.launchFlowLoad(ctx, r, row, attempt, now)
}

// launchFlowLoad starts one load of main's newest commit on a new workspace.
func (s *MythicalService) launchFlowLoad(ctx context.Context, r *mythicalRun, row db.FlowLoad, attempt int32, now time.Time) error {
	q := s.queries()
	main := r.row.LandedMain
	tree, syncing, err := s.flowLoadTree(ctx, r, main, row.Tree)
	if err != nil {
		return err
	}
	// The generation is fixed first: the workspace binds to it before it is provisioned.
	bumped := row
	bumped.Generation, bumped.CommitID, bumped.Syncing = row.Generation+1, main, syncing
	bumped.CommitTree, _ = json.Marshal(tree)
	saved, err := q.SaveFlowLoad(ctx, bumped)
	if err != nil {
		return err
	}
	s.notify(ctx, q, r.row.RepositoryID, r.row.Generation, "flows", "")
	repository, owner, err := s.repository(ctx, r.row.RepositoryID)
	if err != nil {
		return err
	}
	fail := func(reason string, cause error) error {
		current, err := q.GetFlowLoad(ctx, r.row.RepositoryID)
		if err != nil {
			return err
		}
		next := current
		if delay, held := repohost.HeldRetryAfter(cause); held {
			next.Error, next.NextAttemptAt = "", now.Add(delay)
		} else {
			next.Attempt, next.Error, next.NextAttemptAt = attempt+1, reason, now.Add(mythicalWikiBackoff(attempt+1))
		}
		s.wakeWikiAt(r.row.RepositoryID, next.NextAttemptAt)
		return s.saveFlowLoad(ctx, r, next)
	}
	// A load reads and imports flows only: it runs on the platform's default
	// machine, never a TODO's placement.
	workspaceID, err := s.lanes.Create(ctx, repository, owner, r.row.ActorUserID.Int64, fmt.Sprintf("flow-load g%d", saved.Generation), MythicalPlacement{},
		func(workspaceID string) error {
			bound, err := q.BindFlowLoadWorkspace(ctx, r.row.RepositoryID, saved.Generation, workspaceID)
			if err == nil && !bound {
				err = errors.New("the flow-load moved on before its workspace was bound")
			}
			return err
		})
	if err != nil {
		return fail("no flow-load workspace: "+err.Error(), err)
	}
	ref, err := s.retainMainFor(ctx, r, workspaceID, main)
	if err != nil {
		return fail("main could not reach the flow-load workspace: "+err.Error(), err)
	}
	current, err := q.GetFlowLoad(ctx, r.row.RepositoryID)
	if err != nil {
		return err
	}
	if current.Generation != saved.Generation || current.WorkspaceID != workspaceID {
		return errors.New("the flow-load changed while it was launched")
	}
	payload, _ := json.Marshal(map[string]any{"base": map[string]string{"commitId": main, "ref": ref}})
	next := current
	next.State, next.RunID, next.Outcome, next.Result, next.Error = "running", "", "", nil, ""
	next.Attempt = attempt + 1
	next.StartedAt = pgtype.Timestamptz{Time: now, Valid: true}
	return s.admitFlowLoad(ctx, r, next, payload)
}

// flowLoadTree reads the flow files at commit (path to blob) and names the
// flows whose files differ from the last load's tree.
func (s *MythicalService) flowLoadTree(ctx context.Context, r *mythicalRun, commit string, loaded json.RawMessage) (map[string]string, json.RawMessage, error) {
	if !r.g.has(ctx, commit) {
		if err := r.g.fetch(ctx, r.bridge.URL(), 1, 0, "refs/heads/"+r.branch); err != nil {
			return nil, nil, fmt.Errorf("fetch main: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	listing, err := r.g.git(ctx, "ls-tree", "-r", commit, "--", "flows/")
	if err != nil {
		return nil, nil, err
	}
	tree := map[string]string{}
	for _, line := range strings.Split(listing, "\n") {
		meta, path, ok := strings.Cut(line, "\t")
		if fields := strings.Fields(meta); ok && len(fields) == 3 && fields[1] == "blob" {
			tree[path] = fields[2]
		}
	}
	var before map[string]string
	_ = json.Unmarshal(loaded, &before)
	// Each flow owns its entry's directory: flows/<name>/ in either tree.
	dirs := map[string]string{}
	entries := map[string]string{} // flow name -> entry path at commit
	for _, files := range []map[string]string{before, tree} {
		for path := range files {
			if name, ok := flowEntryName(path); ok {
				dirs["flows/"+name+"/"] = name
			}
		}
	}
	for path := range tree {
		if name, ok := flowEntryName(path); ok {
			entries[name] = path
		}
	}
	changed := map[string]bool{}
	for path := range unionKeys(before, tree) {
		if before[path] == tree[path] {
			continue
		}
		owner, longest := "", 0
		for dir, name := range dirs {
			if strings.HasPrefix(path, dir) && len(dir) > longest {
				owner, longest = name, len(dir)
			}
		}
		if owner != "" && Overridable(owner) {
			changed[owner] = true
		}
	}
	syncing := []flowSyncing{}
	for _, name := range slices.Sorted(maps.Keys(changed)) {
		flow := flowSyncing{Name: name}
		if path, ok := entries[name]; ok {
			if bytes, err := r.g.command(ctx, nil, "cat-file", "blob", tree[path]); err == nil {
				digest := sha256.Sum256(bytes)
				flow.Digest = hex.EncodeToString(digest[:])
			}
		}
		syncing = append(syncing, flow)
	}
	encoded, _ := json.Marshal(syncing)
	return tree, encoded, nil
}

// flowEntryName answers the flow a path declares: flows/<name>/flow.ts (or .mdx).
func flowEntryName(path string) (string, bool) {
	for _, suffix := range []string{"/flow.ts", "/flow.tsx", "/flow.mdx", "/flow.md"} {
		if name, ok := strings.CutSuffix(strings.TrimPrefix(path, "flows/"), suffix); ok && strings.HasPrefix(path, "flows/") && name != "" {
			return name, true
		}
	}
	return "", false
}

func unionKeys(a, b map[string]string) map[string]bool {
	keys := map[string]bool{}
	for key := range a {
		keys[key] = true
	}
	for key := range b {
		keys[key] = true
	}
	return keys
}

// retainMainFor makes main's commit reachable in the workspace's source ref.
func (s *MythicalService) retainMainFor(ctx context.Context, r *mythicalRun, workspaceID, commit string) (string, error) {
	if !r.g.has(ctx, commit) {
		if err := r.g.fetch(ctx, r.bridge.URL(), 1, 0, "refs/heads/"+r.branch); err != nil {
			return "", fmt.Errorf("fetch main: %s", sanitizeMirrorError(err, r.bridge.URL()))
		}
	}
	return s.retainFor(ctx, r, workspaceID, commit)
}

// admitFlowLoad saves the running load and admits its launch in one
// transaction, so a crash never leaves a launch the row does not know about.
func (s *MythicalService) admitFlowLoad(ctx context.Context, r *mythicalRun, next db.FlowLoad, payload json.RawMessage) error {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	saved, err := db.New(tx).SaveFlowLoad(ctx, next)
	if err != nil {
		return err
	}
	tenant, principal := "repository:"+strconv.FormatInt(r.row.RepositoryID, 10), "user:"+strconv.FormatInt(r.row.ActorUserID.Int64, 10)
	projection, _ := json.Marshal(flowLoadProjection{Kind: flowLoadBindingKind, RepositoryID: r.row.RepositoryID, Generation: saved.Generation})
	authorization, _ := json.Marshal(map[string]any{"repositoryId": r.row.RepositoryID, "userId": r.row.ActorUserID.Int64,
		"workspaceId": saved.WorkspaceID, "generation": saved.Generation})
	if _, err := s.launcher.AdmitInTx(ctx, tx, flowdispatch.LaunchRequest{
		Scope:     jobs.Scope{TenantID: tenant, PrincipalID: principal},
		RequestID: fmt.Sprintf("flow-load:%d:%d:%s", r.row.RepositoryID, saved.Generation, saved.CommitID),
		Target: flowruntime.FlowRuntimeTarget{TenantID: tenant, PrincipalID: principal, WorkspaceID: saved.WorkspaceID,
			BindingKind: flowLoadBindingKind, BindingID: strconv.FormatInt(r.row.RepositoryID, 10)},
		FlowID: flowLoadFlow, Payload: payload, AuthorizationContext: authorization, Projection: projection,
		// A system flow the install runs on every main move.
		ApprovalPolicy: flowdispatch.ApprovalAuto,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		if persisted, readErr := s.queries().GetFlowLoad(context.WithoutCancel(ctx), r.row.RepositoryID); readErr == nil && persisted.Version == saved.Version {
			s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "flows", "")
			return nil
		}
		return err
	}
	s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "flows", "")
	return nil
}

// settleFlowLoad writes a finished load's versions and moves Active, or
// records why the load did not finish.
func (s *MythicalService) settleFlowLoad(ctx context.Context, r *mythicalRun, row db.FlowLoad, now time.Time) error {
	timedOut := row.StartedAt.Valid && now.Sub(row.StartedAt.Time) > flowLoadTimeout
	neverStarted := row.RunID == "" && row.StartedAt.Valid && now.Sub(row.StartedAt.Time) > flowLoadStartTimeout
	next := row
	switch {
	case row.Outcome == "succeeded":
		result, err := decodeFlowLoadResult(row.Result, row.CommitID)
		if err == nil {
			return s.persistFlowLoad(ctx, r, row, result)
		}
		next.Error = err.Error()
	case row.Outcome != "":
		next.Error = strings.TrimPrefix(row.Outcome, "failed: ")
	case neverStarted:
		next.Error = "the load did not start within " + flowLoadStartTimeout.String()
	case timedOut:
		next.Error = "the load did not finish within " + flowLoadTimeout.String()
	default:
		return nil
	}
	next.State, next.Outcome, next.Result = "idle", "", nil
	next.NextAttemptAt = now.Add(mythicalWikiBackoff(row.Attempt))
	s.wakeWikiAt(r.row.RepositoryID, next.NextAttemptAt)
	failed, err := s.queries().SaveFlowLoad(ctx, next)
	if errors.Is(err, pgx.ErrNoRows) {
		s.MainMoved(ctx, r.row.RepositoryID)
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.retireFlowLoadWorkspace(ctx, r, &failed); err != nil {
		s.logger.Warn("mythical.flow_load_retire_failed", "repository_id", r.row.RepositoryID, "error", err)
		return nil
	}
	return s.saveFlowLoad(ctx, r, failed)
}

// persistFlowLoad commits one load: its versions, Active, and the load row,
// in one transaction (§11.3.2), then retires its workspace.
func (s *MythicalService) persistFlowLoad(ctx context.Context, r *mythicalRun, row db.FlowLoad, result FlowLoadResult) error {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	moved, err := persistFlowVersions(ctx, q, r.row.RepositoryID, row.CommitID, result.Flows)
	if err != nil {
		return err
	}
	versions, _ := json.Marshal(result.Flows)
	next := row
	next.State, next.LoadedCommit, next.Versions, next.Tree, next.Syncing = "idle", row.CommitID, versions, row.CommitTree, json.RawMessage("[]")
	next.Outcome, next.Result, next.Error, next.Attempt = "", nil, "", 0
	saved, err := q.SaveFlowLoad(ctx, next)
	if errors.Is(err, pgx.ErrNoRows) {
		s.MainMoved(ctx, r.row.RepositoryID)
		return nil
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.logger.Info("mythical.flow_load_settled", "repository_id", r.row.RepositoryID, "commit", row.CommitID, "flows", len(result.Flows), "activated", moved)
	s.notify(ctx, s.queries(), r.row.RepositoryID, r.row.Generation, "flows", "")
	if err := s.retireFlowLoadWorkspace(ctx, r, &saved); err != nil {
		s.logger.Warn("mythical.flow_load_retire_failed", "repository_id", r.row.RepositoryID, "error", err)
		return nil
	}
	return s.saveFlowLoad(ctx, r, saved)
}

// retireFlowLoadWorkspace deletes the load's workspace and clears it on next.
func (s *MythicalService) retireFlowLoadWorkspace(ctx context.Context, r *mythicalRun, next *db.FlowLoad) error {
	if next.WorkspaceID == "" {
		return nil
	}
	if err := s.lanes.Delete(ctx, r.row.RepositoryID, r.row.ActorUserID.Int64, next.WorkspaceID); err != nil {
		return err
	}
	next.WorkspaceID = ""
	return nil
}

func (s *MythicalService) saveFlowLoad(ctx context.Context, r *mythicalRun, next db.FlowLoad) error {
	if _, err := s.queries().SaveFlowLoad(ctx, next); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// A projection saved first; the next pass sees it.
			s.MainMoved(ctx, r.row.RepositoryID)
			return nil
		}
		return err
	}
	return nil
}

// projectFlowLoad records a flow-load run's id and terminal outcome on its
// load and wakes the worker. An older generation's projection changes nothing.
func (s *MythicalService) projectFlowLoad(ctx context.Context, update flowdispatch.ProjectionUpdate, projection flowLoadProjection) error {
	q := s.queries()
	for range 3 {
		row, err := q.GetFlowLoad(ctx, projection.RepositoryID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if row.Generation != projection.Generation || row.State != "running" {
			return nil
		}
		next := row
		if runID := strings.TrimSpace(update.Checkpoint.RunID); runID != "" {
			next.RunID = runID
		}
		if row.Outcome == "" {
			switch update.State {
			case jobs.StateCompleted:
				output := ""
				if update.Checkpoint.Run != nil && update.Checkpoint.Run.FinalOutput != nil {
					output = *update.Checkpoint.Run.FinalOutput
				}
				if _, err := decodeFlowLoadResult([]byte(output), row.CommitID); err != nil {
					next.Outcome = "failed: " + err.Error()
				} else {
					next.Outcome, next.Result = "succeeded", []byte(output)
				}
			case jobs.StateFailed, jobs.StateCancelled:
				next.Outcome = "failed: " + mythicalWikiFailure(update)
			}
		}
		if next.RunID == row.RunID && next.Outcome == row.Outcome {
			return nil
		}
		if _, err := q.SaveFlowLoad(ctx, next); errors.Is(err, pgx.ErrNoRows) {
			continue
		} else if err != nil {
			return err
		}
		if next.Outcome != row.Outcome {
			s.MainMoved(ctx, projection.RepositoryID)
		}
		return nil
	}
	return errors.New("the flow-load is busy; retry the projection")
}

// FlowLoadRuntime is flow-load's side of the Flow runtime: it authorizes a
// flow-load launch before a host starts and records its run's outcome.
type FlowLoadRuntime struct{ service *MythicalService }

func NewFlowLoadRuntime(service *MythicalService) *FlowLoadRuntime {
	return &FlowLoadRuntime{service: service}
}

// ProjectFlowRuntime records a flow-load run's id and outcome; every other
// projection is not flow-load's.
func (runtime *FlowLoadRuntime) ProjectFlowRuntime(ctx context.Context, update flowdispatch.ProjectionUpdate) error {
	var projection flowLoadProjection
	if runtime == nil || runtime.service == nil || json.Unmarshal(update.Checkpoint.Projection, &projection) != nil || projection.Kind != flowLoadBindingKind {
		return nil
	}
	return runtime.service.projectFlowLoad(ctx, update, projection)
}

// ResolveFlowHostTarget authorizes a flow-load launch against the
// repository's load and stack before the flowhost resolver starts a host.
func (runtime *FlowLoadRuntime) ResolveFlowHostTarget(ctx context.Context, target flowruntime.FlowRuntimeTarget) (flowhost.Authority, error) {
	if runtime == nil || runtime.service == nil || target.BindingKind != flowLoadBindingKind {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_unsupported"}
	}
	repositoryID, repositoryOK := scopedFlowRuntimeID(target.TenantID, "repository:")
	userID, userOK := scopedFlowRuntimeID(target.PrincipalID, "user:")
	bound, err := strconv.ParseInt(target.BindingID, 10, 64)
	if !repositoryOK || !userOK || err != nil || bound != repositoryID {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_invalid"}
	}
	q := runtime.service.queries()
	row, err := q.GetFlowLoad(ctx, repositoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_not_found"}
		}
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: true}
	}
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if err != nil {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_binding_unavailable", retryable: !errors.Is(err, pgx.ErrNoRows)}
	}
	if !stack.ActorUserID.Valid || stack.ActorUserID.Int64 != userID || row.WorkspaceID == "" ||
		(target.WorkspaceID != "" && target.WorkspaceID != row.WorkspaceID) {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_target_forbidden"}
	}
	// The workspace is provisioned in the background after the launch is
	// admitted: a host bound before its checkout exists would pin a source
	// revision the finished checkout no longer has.
	if workspace, err := q.GetWorkspace(ctx, row.WorkspaceID); err != nil || workspace.Status != "running" {
		return flowhost.Authority{}, mythicalFlowFailure{code: "runtime_workspace_pending", retryable: err == nil || !errors.Is(err, pgx.ErrNoRows)}
	}
	return flowhost.Authority{Target: target, RepositoryID: repositoryID, UserID: userID, WorkspaceID: row.WorkspaceID,
		CatalogKey: flowhost.CatalogCoding}, nil
}
