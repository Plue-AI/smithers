package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Flow versions (engineering spec §4.3, §11.3): flow-load writes one
// workflow_definitions row per (name, digest) it measured, and the row marked
// is_active is the flow's Active version. A flow with no Active row runs its
// built-in version, whose digest the install ships (builtin_flows.json).

// FlowLoadVersion is one flow version as flow-load measured it at one commit
// (FlowVersion in flows/coding/flow-load.ts).
type FlowLoadVersion struct {
	Name         string   `json:"name"`
	Path         string   `json:"path"`
	Digest       string   `json:"digest"`
	Status       string   `json:"status"`
	Error        string   `json:"error,omitempty"`
	Dependencies []string `json:"dependencies,omitempty"`
}

// FlowLoadResult is a flow-load run's output (FlowLoadResult in
// flows/coding/flow-load.ts).
type FlowLoadResult struct {
	CommitID string            `json:"commitId"`
	Flows    []FlowLoadVersion `json:"flows"`
}

// flowSyncing is a flow whose files changed on main since the last load: the
// Flow card shows it merged and not yet active. Digest is the content digest
// of its entry at main, when it has one.
type flowSyncing struct {
	Name   string `json:"name"`
	Digest string `json:"digest,omitempty"`
}

var flowCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func decodeFlowLoadResult(raw []byte, commit string) (FlowLoadResult, error) {
	var result FlowLoadResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, fmt.Errorf("the flow-load output is not a FlowLoadResult: %w", err)
	}
	if result.CommitID != commit {
		return result, fmt.Errorf("flow-load measured %s, not the commit it was launched on", short(result.CommitID))
	}
	seen := map[string]bool{}
	for _, flow := range result.Flows {
		if flow.Name == "" || seen[flow.Name] || !repositoryJobDigest.MatchString(flow.Digest) ||
			(flow.Status != "loaded" && flow.Status != "failed") || (flow.Status == "failed") != (flow.Error != "") {
			return result, fmt.Errorf("flow-load answered an invalid version of %q", flow.Name)
		}
		seen[flow.Name] = true
	}
	return result, nil
}

// flowVersionConfig is the config a version row stores: the steps the Flow
// card shows for it. A repository todo composition runs the host's steps
// (@smthrs/coding), so its steps are the built-in's.
func flowVersionConfig(name string) json.RawMessage {
	steps := builtinFlowSteps[name]
	if steps == nil {
		steps = []FlowStep{}
	}
	config, _ := json.Marshal(map[string]any{"steps": steps})
	return config
}

// storedFlowSteps reads only the metadata persisted with this version. Older
// definitions without steps retain the built-in display; an explicit empty
// array describes a flow with no published steps.
func storedFlowSteps(config json.RawMessage, fallback []FlowStep) []FlowStep {
	var metadata struct {
		Steps []FlowStep `json:"steps"`
	}
	if json.Unmarshal(config, &metadata) != nil || metadata.Steps == nil {
		return fallback
	}
	return metadata.Steps
}

// persistFlowVersions writes one load's versions at commit and moves Active
// (§11.3.1, §11.3.2), in the caller's transaction. A digest that already has
// a row writes nothing; a loaded version becomes Active; a failed one leaves
// Active where it was. An overridable flow the repository no longer declares
// returns to its built-in version. It answers the flows whose Active moved.
func persistFlowVersions(ctx context.Context, q *db.Queries, repositoryID int64, commit string, versions []FlowLoadVersion, activate ...bool) ([]string, error) {
	if !flowCommitPattern.MatchString(commit) {
		return nil, errors.New("flow versions need the main commit they were loaded at")
	}
	current := len(activate) == 0 || activate[0]
	declared := map[string]bool{}
	moved := []string{}
	for _, version := range versions {
		if !Overridable(version.Name) {
			continue
		}
		declared[version.Name] = true
		if _, err := q.InsertFlowVersion(ctx, repositoryID, version.Name, version.Path, commit, version.Digest, version.Status,
			version.Error, flowVersionConfig(version.Name)); err != nil {
			return nil, fmt.Errorf("record %s at %s: %w", version.Name, short(version.Digest), err)
		}
		if version.Status != "loaded" || !current {
			continue
		}
		activated, err := q.ActivateFlowVersion(ctx, repositoryID, version.Name, version.Digest)
		if err != nil {
			return nil, fmt.Errorf("activate %s at %s: %w", version.Name, short(version.Digest), err)
		}
		if activated {
			moved = append(moved, version.Name)
		}
	}
	if !current {
		return moved, nil
	}
	rows, err := q.ListFlowVersions(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.IsActive && !declared[row.Name] {
			if _, err := q.DeactivateFlowVersions(ctx, repositoryID, row.Name); err != nil {
				return nil, err
			}
			moved = append(moved, row.Name)
		}
	}
	return moved, nil
}

// ActiveFlowDigest answers the digest of a flow's Active version: the
// repository's Active row, else the built-in version the install ships.
func ActiveFlowDigest(ctx context.Context, q *db.Queries, repositoryID int64, name string) (string, error) {
	// A historical repository row cannot supply an install command, even
	// before the next flow-load deactivates a formerly accepted override.
	if !Overridable(name) {
		return "", fmt.Errorf("flow %q is install-owned", name)
	}
	rows, err := q.ListFlowVersions(ctx, repositoryID)
	if err != nil {
		return "", err
	}
	for _, row := range rows {
		if row.Name == name && row.IsActive && row.Digest.Valid {
			return row.Digest.String, nil
		}
	}
	digests, err := builtinFlowDigests()
	if err != nil {
		return "", err
	}
	if digest, ok := digests[name]; ok {
		return digest, nil
	}
	return "", fmt.Errorf("flow %q has no Active version", name)
}

// RepositoryFlowCatalog is GET /api/flows for one repository (§6.3, §4.3):
// each overridable flow with its Active version, the version it replaced
// (previous), a merged version not yet loaded (merged-syncing) and a merged
// version that failed to load (merged-failed, with its error). Reserved
// repository declarations are read-only failed cards, never executable versions.
func RepositoryFlowCatalog(ctx context.Context, q *db.Queries, repositoryID int64, readers ...FlowProposalReader) ([]FlowCard, error) {
	digests, err := builtinFlowDigests()
	if err != nil {
		return nil, err
	}
	rows, err := q.ListFlowVersions(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	load, err := q.GetFlowLoad(ctx, repositoryID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var measured []FlowLoadVersion
	var syncing []flowSyncing
	_ = json.Unmarshal(load.Versions, &measured)
	pending := load.State == "running" || (load.CommitID != "" && load.CommitID != load.LoadedCommit)
	if pending {
		_ = json.Unmarshal(load.Syncing, &syncing)
	}
	// A load that could not run at all, after its last attempt, is not
	// syncing any more: the merged versions failed to load.
	exhausted := pending && load.State == "idle" && load.Attempt >= flowLoadAttempts && load.Error != ""
	proposals := map[string][]FlowVersion{}
	if len(readers) > 0 && readers[0] != nil {
		proposals, err = readers[0].FlowProposals(ctx, repositoryID)
		if err != nil {
			return nil, err
		}
	}
	names := map[string]bool{}
	for name := range proposals {
		names[name] = true
	}
	for name := range digests {
		names[name] = true
	}
	for _, row := range rows {
		names[row.Name] = true
	}
	for _, flow := range syncing {
		names[flow.Name] = true
	}
	for _, flow := range measured {
		names[flow.Name] = true
	}
	cards := []FlowCard{}
	for _, name := range slices.Sorted(maps.Keys(names)) {
		if !Overridable(name) {
			// Never project historical Active overrides or proposals for system
			// names. Only a current measured declaration has a refusal to show.
			card := FlowCard{Name: name, System: true, Versions: []FlowVersion{}}
			for _, version := range measured {
				if version.Name == name {
					card.Source = FlowSource{Path: version.Path}
					card.Versions = append(card.Versions, FlowVersion{ID: version.Digest,
						State: "merged-failed", Error: "reserved_name", Steps: []FlowStep{}})
				}
			}
			if len(card.Versions) > 0 {
				cards = append(cards, card)
			}
			continue
		}
		steps := builtinFlowSteps[name]
		if steps == nil {
			steps = []FlowStep{}
		}
		card := FlowCard{Name: name, Versions: []FlowVersion{}}
		var active *db.WorkflowDefinition
		for i := range rows {
			if rows[i].Name == name && rows[i].IsActive {
				active = &rows[i]
			}
		}
		builtin, hasBuiltin := digests[name]
		switch {
		case active != nil:
			card.Source = FlowSource{Path: active.Path}
			card.Versions = append(card.Versions, FlowVersion{ID: active.Digest.String, State: "active", Steps: storedFlowSteps(active.Config, steps)})
		case hasBuiltin:
			card.Source = FlowSource{Builtin: true}
			card.Versions = append(card.Versions, FlowVersion{ID: builtin, State: "active", Steps: steps})
		}
		for _, flow := range syncing {
			if flow.Name == name && exhausted {
				card.Versions = append(card.Versions, FlowVersion{ID: flow.Digest, State: "merged-failed", Error: "flow-load did not run: " + load.Error, Steps: steps})
			} else if flow.Name == name {
				card.Versions = append(card.Versions, FlowVersion{ID: flow.Digest, State: "merged-syncing", Steps: steps})
			}
		}
		// The last load's failure for this flow, while it is still main's.
		for _, version := range measured {
			if version.Name != name || version.Status != "failed" {
				continue
			}
			failure := FlowVersion{ID: version.Digest, State: "merged-failed", Error: version.Error, Steps: steps}
			for _, row := range rows {
				if row.Name == name && row.Digest.String == version.Digest && row.LoadError != "" {
					failure.Error = row.LoadError
					failure.Steps = storedFlowSteps(row.Config, steps)
				}
			}
			card.Versions = append(card.Versions, failure)
			if card.Source == (FlowSource{}) {
				card.Source = FlowSource{Path: version.Path}
			}
		}
		// previous: the loaded version Active replaced, else the built-in.
		if active != nil {
			previous := ""
			previousSteps := steps
			for _, row := range rows {
				if row.Name == name && row.ID < active.ID && row.Status.String == "loaded" && row.Digest.String != active.Digest.String {
					previous = row.Digest.String
					previousSteps = storedFlowSteps(row.Config, steps)
				}
			}
			if previous == "" && hasBuiltin && builtin != active.Digest.String {
				previous = builtin
			}
			if previous != "" {
				card.Versions = append(card.Versions, FlowVersion{ID: previous, State: "previous", Steps: previousSteps})
			}
		}
		card.Versions = append(card.Versions, proposals[name]...)
		if card.Source == (FlowSource{}) && len(proposals[name]) > 0 {
			card.Source = FlowSource{Path: "flows/" + name + "/flow.ts"}
		}
		if len(card.Versions) == 0 {
			continue
		}
		cards = append(cards, card)
	}
	return cards, nil
}
