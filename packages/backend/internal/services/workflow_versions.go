package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// FlowLoadedVersion is metadata from the packaged guest operation. No source,
// closure upload or dependency archive crosses this seam (spec §11.3.0).
type FlowLoadedVersion struct {
	Name   string   `json:"name"`
	Digest string   `json:"digest"`
	Status string   `json:"status"`
	Error  string   `json:"error,omitempty"`
	Steps  []string `json:"steps"`
}

// FlowLoadGuest is supplied only after T-FLW-01/11, T-INS-02 and T-SEC-01
// have production C-SEC-02 receipts. It owns one background system/flow-load
// run and ephemeral microVM, main-pinned source/dependencies, guest typechecking
// and teardown. There is deliberately no process or host parser fallback.
type FlowLoadGuest interface {
	Load(context.Context, int64, string) ([]FlowLoadedVersion, error)
}

type flowLoadState struct {
	pending string
	running string
	loaded  string
}

var flowCommit = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)
var flowDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// RequestFlowLoad records the newest commit and returns before machine startup
// or completion. The production poll callback stays unbound until its providers
// and integration gates land. Configuration is install-lifetime, before use.
func (s *WorkflowSyncService) RequestFlowLoad(ctx context.Context, repositoryID int64, commit string) error {
	if s == nil || s.flowGuest == nil || s.flowPublish == nil || s.queries == nil {
		return fmt.Errorf("flow-load production providers are unavailable")
	}
	if _, ok := s.queries.(*db.Queries); !ok {
		return fmt.Errorf("flow-load transactional persistence is unavailable")
	}
	if repositoryID <= 0 || !flowCommit.MatchString(commit) {
		return fmt.Errorf("flow-load repository and immutable commit are required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.flowMu.Lock()
	defer s.flowMu.Unlock()
	if s.flowLoads == nil {
		s.flowLoads = make(map[int64]*flowLoadState)
	}
	state := s.flowLoads[repositoryID]
	if state == nil {
		state = &flowLoadState{}
		s.flowLoads[repositoryID] = state
	}
	if commit == state.running || commit == state.loaded {
		state.pending = ""
		return nil
	}
	state.pending = commit
	if state.running == "" {
		state.running, state.pending = state.pending, ""
		go s.runFlowLoads(ctx, repositoryID, state)
	}
	return nil
}

func (s *WorkflowSyncService) runFlowLoads(ctx context.Context, repositoryID int64, state *flowLoadState) {
	for {
		s.flowMu.Lock()
		commit := state.running
		s.flowMu.Unlock()
		result, err := s.loadFlowVersions(ctx, repositoryID, commit)
		if err == nil {
			err = s.PersistDefinitions(ctx, repositoryID, result)
		}
		if err != nil {
			slog.ErrorContext(ctx, "flow-load failed", "repository_id", repositoryID, "source_commit", commit, "error", err)
		}
		// Load failures remain a failed run owned by the guest provider. Per-flow
		// failures are returned as metadata and persisted, rather than logged away.
		s.flowMu.Lock()
		if err == nil {
			state.loaded = commit
		}
		if state.pending == "" || ctx.Err() != nil {
			state.running, state.pending = "", ""
			s.flowMu.Unlock()
			return
		}
		state.running, state.pending = state.pending, ""
		s.flowMu.Unlock()
	}
}

func (s *WorkflowSyncService) loadFlowVersions(ctx context.Context, repoID int64, commit string) (WorkflowLoadResult, error) {
	if s.flowGuest == nil || s.flowPublish == nil {
		return WorkflowLoadResult{}, fmt.Errorf("flow-load production providers are unavailable")
	}
	current, err := s.isDefaultHeadCommit(ctx, repoID, commit)
	if err != nil {
		return WorkflowLoadResult{}, err
	}
	if !current {
		return WorkflowLoadResult{}, fmt.Errorf("flow-load commit is not current main")
	}
	versions, err := s.flowGuest.Load(ctx, repoID, commit)
	if err != nil {
		return WorkflowLoadResult{}, err
	}
	// Stamp provenance here, never from guest-supplied repository/head fields.
	return WorkflowLoadResult{repositoryID: repoID, commitSHA: commit, versioned: true, versions: versions}, nil
}

func (s *WorkflowSyncService) persistFlowVersions(ctx context.Context, repoID int64, result WorkflowLoadResult) error {
	q, ok := s.queries.(*db.Queries)
	if !ok || s.flowPublish == nil {
		return fmt.Errorf("flow version persistence providers are unavailable")
	}
	seen := make(map[string]bool)
	for _, v := range result.versions {
		if v.Name == "" || !Overridable(v.Name) || strings.Contains(v.Name, "..") || strings.ContainsAny(v.Name, "\\\x00") || strings.HasPrefix(v.Name, "/") ||
			!flowDigest.MatchString(v.Digest) || seen[v.Name] ||
			(v.Status != "loaded" && v.Status != "failed") || (v.Status == "loaded" && v.Error != "") || (v.Status == "failed" && v.Error == "") {
			return fmt.Errorf("invalid flow-load metadata for %q", v.Name)
		}
		seen[v.Name] = true
	}
	if !flowCommit.MatchString(result.commitSHA) {
		return fmt.Errorf("invalid flow-load source commit")
	}
	tx, err := q.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	// Serialize versions and activation across service instances, not only this process.
	var locked int64
	if err := tx.QueryRow(ctx, `SELECT id FROM repositories WHERE id=$1 FOR UPDATE`, repoID).Scan(&locked); err != nil {
		return err
	}
	queries := q.WithTx(tx)
	// Head/owner reads share the activation connection. A one-connection pool
	// must not wait for itself while holding the repository row lock.
	bound := NewWorkflowSyncService(queries, s.repoHost, nil)
	current, err := bound.isDefaultHeadCommit(ctx, repoID, result.commitSHA)
	if err != nil {
		return err
	}
	changed := false
	for _, v := range result.versions {
		config, err := json.Marshal(struct {
			Steps []string `json:"steps"`
		}{v.Steps})
		if err != nil {
			return err
		}
		def, err := queries.InsertWorkflowVersion(ctx, db.InsertWorkflowVersionParams{
			RepositoryID: repoID, Name: v.Name, Path: "flows/" + v.Name + "/flow.ts", Config: config,
			SourceCommit: pgtype.Text{String: result.commitSHA, Valid: true}, Digest: pgtype.Text{String: v.Digest, Valid: true},
			Status: pgtype.Text{String: v.Status, Valid: true}, LoadError: pgtype.Text{String: v.Error, Valid: v.Status == "failed"},
		})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		changed = true
		if current && v.Status == "loaded" {
			if err := queries.DeactivateWorkflowVersionsByName(ctx, db.DeactivateWorkflowVersionsByNameParams{RepositoryID: repoID, Name: v.Name}); err != nil {
				return err
			}
			if err := queries.ActivateWorkflowVersion(ctx, db.ActivateWorkflowVersionParams{RepositoryID: repoID, ID: def.ID}); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if changed {
		s.flowPublish(ctx, repoID)
	}
	return nil
}

// FlowVersionProposal contains committed stack candidate diff paths supplied by
// the stack provider. Working-copy diffs never enter the flows projection.
type FlowVersionProposal struct {
	TODO  int64
	Paths []string
}

// FlowVersionView is the metadata-only flows projection (spec §4.3, §7.2).
// The catalog route/topic remain unmounted until authorization, live publication
// and catalog descriptor providers pass their production integration gates.
type FlowVersionView struct {
	Name         string   `json:"name"`
	SourceCommit string   `json:"source_commit,omitempty"`
	Digest       string   `json:"digest,omitempty"`
	State        string   `json:"state"`
	Error        string   `json:"error,omitempty"`
	Steps        []string `json:"steps"`
	TODO         int64    `json:"todo,omitempty"`
}

func projectWorkflowVersions(rows []db.WorkflowDefinition, syncingCommit string, proposed []FlowVersionProposal) ([]FlowVersionView, error) {
	versions := make([]FlowVersionView, 0, len(rows))
	names := make(map[string]bool)
	for _, row := range rows {
		if !row.Digest.Valid {
			continue
		}
		var config struct {
			Steps []string `json:"steps"`
		}
		if err := json.Unmarshal(row.Config, &config); err != nil {
			return nil, fmt.Errorf("invalid flow steps: %w", err)
		}
		state := "previous"
		if row.IsActive {
			state = "active"
		} else if row.Status.String == "failed" {
			state = "merged-failed"
		}
		versions = append(versions, FlowVersionView{Name: row.Name, SourceCommit: row.SourceCommit.String, Digest: row.Digest.String, State: state, Error: row.LoadError.String, Steps: config.Steps})
		names[row.Name] = true
	}
	for _, proposal := range proposed {
		for _, path := range proposal.Paths {
			if strings.HasPrefix(path, "flows/") && strings.HasSuffix(path, "/flow.ts") {
				name := strings.TrimSuffix(strings.TrimPrefix(path, "flows/"), "/flow.ts")
				if name != "" && Overridable(name) {
					if _, ok := names[name]; !ok {
						names[name] = false
					}
				}
			}
		}
	}
	// Stable order keeps identical snapshots identical across reconnects.
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	slices.Sort(ordered)
	for _, name := range ordered {
		if syncingCommit != "" && names[name] {
			versions = append(versions, FlowVersionView{Name: name, SourceCommit: syncingCommit, State: "merged-syncing", Steps: []string{}})
		}
		for _, proposal := range proposed {
			for _, path := range proposal.Paths {
				if strings.HasPrefix(path, "flows/"+name+"/") {
					versions = append(versions, FlowVersionView{Name: name, State: "proposed", TODO: proposal.TODO, Steps: []string{}})
					break
				}
			}
		}
	}
	return versions, nil
}
