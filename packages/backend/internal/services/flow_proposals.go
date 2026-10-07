package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// FlowProposalReader reads immutable candidate diffs, never a working copy.
type FlowProposalReader interface {
	FlowProposals(context.Context, int64) (map[string][]FlowVersion, error)
}

// FlowProposals projects the open TODOs' recorded candidates without loading
// repository code. Candidate identity is provisional until main's guest load.
func (s *MythicalService) FlowProposals(ctx context.Context, repositoryID int64) (map[string][]FlowVersion, error) {
	proposals := map[string][]FlowVersion{}
	items, err := s.queries().ListMythicalFlowCandidates(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	items = slices.DeleteFunc(items, func(item db.MythicalItem) bool {
		return !item.Number.Valid || !mythicalSHA.MatchString(item.CandidateBase) || !mythicalSHA.MatchString(item.CandidateHead) ||
			slices.Contains([]string{"landed", "cancelled", "declined", "skipped", "rejected"}, item.State)
	})
	if len(items) == 0 {
		return proposals, nil
	}
	if s.host == nil {
		return nil, fmt.Errorf("candidate source unavailable")
	}
	repo, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repo.Name, RepositoryStillAt(s.queries(), repositoryID, owner, repo.Name))
	if err != nil {
		return nil, err
	}
	defer bridge.Close()
	g, cleanup, err := s.forkGit(ctx, repositoryID)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	for _, item := range items {
		for _, rev := range []string{item.CandidateBase, item.CandidateHead} {
			if !g.has(ctx, rev) {
				if err := g.fetch(ctx, bridge.URL(), 0, 0, rev); err != nil {
					return nil, err
				}
			}
		}
		paths, err := g.changedPaths(ctx, item.CandidateBase, item.CandidateHead)
		if err != nil {
			return nil, err
		}
		dirs := map[string]string{}
		for _, rev := range []string{item.CandidateBase, item.CandidateHead} {
			listing, err := g.command(ctx, nil, "ls-tree", "-r", "-z", "--name-only", rev, "--", "flows/")
			if err != nil {
				return nil, err
			}
			for _, path := range strings.Split(string(listing), "\x00") {
				if name, ok := flowEntryName(path); ok && Overridable(name) {
					dirs["flows/"+name+"/"] = name
				}
			}
		}
		names := map[string]bool{}
		for _, path := range paths {
			name, longest := "", 0
			for dir, flow := range dirs {
				if strings.HasPrefix(path, dir) && len(dir) > longest {
					name, longest = flow, len(dir)
				}
			}
			if name != "" {
				names[name] = true
			}
		}
		for name := range names {
			sum := sha256.Sum256([]byte(item.CandidateHead + ":" + name))
			steps := builtinFlowSteps[name]
			if steps == nil {
				steps = []FlowStep{}
			}
			proposals[name] = append(proposals[name], FlowVersion{ID: hex.EncodeToString(sum[:]), State: "proposed", Todo: item.Number.Int64, Steps: steps})
		}
	}
	return proposals, nil
}
