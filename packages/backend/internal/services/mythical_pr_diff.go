package services

import (
	"fmt"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// BranchDiff is the item-base subset of the shared DiffCard contract, with
// the commits it spans. The existing landing response exposes raw patches,
// not the card's hunk model.
type BranchDiff struct {
	Files   []BranchDiffModel `json:"files"`
	Commits []BranchCommit    `json:"commits,omitempty"`
}

// BranchCommit is one commit of a branch's change.
type BranchCommit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	At      string `json:"at"`
}
type BranchDiffModel struct {
	Path      string            `json:"path"`
	Branch    string            `json:"branch"`
	Against   BranchDiffAgainst `json:"against"`
	Change    string            `json:"change"`
	RenamedTo string            `json:"renamed_to,omitempty"`
	Binary    *BranchDiffBinary `json:"binary,omitempty"`
	Hunks     []BranchDiffHunk  `json:"hunks"`
}
type BranchDiffAgainst struct {
	Kind string `json:"kind"`
	Rev  string `json:"rev"`
}
type BranchDiffBinary struct {
	BeforeBytes int64 `json:"before_bytes"`
	AfterBytes  int64 `json:"after_bytes"`
}
type BranchDiffHunk struct {
	OldStart int64            `json:"old_start"`
	NewStart int64            `json:"new_start"`
	Lines    []BranchDiffLine `json:"lines"`
}
type BranchDiffLine struct {
	Op   string `json:"op"`
	Text string `json:"text"`
}

// ProjectTODOBranchDiff consumes a diff already read against the immutable
// accepted prefix. It performs no git or machine execution. Binary sizes must
// come from blob metadata: FileDiff omits binary content, so len is not a size.
// BranchDiff compares against the item's recorded candidate base, never a
// guessed main.
func ProjectTODOBranchDiff(branch, acceptedPrefix string, files []repohost.FileDiff, binarySizes map[string]BranchDiffBinary) (BranchDiff, error) {
	result := BranchDiff{Files: []BranchDiffModel{}}
	if branch == "" || acceptedPrefix == "" {
		return BranchDiff{}, &mythicalPRUnavailable{}
	}
	for _, file := range files {
		if file.Path == "" || file.TooLarge {
			return BranchDiff{}, &mythicalPRUnavailable{}
		}
		model := BranchDiffModel{Path: file.Path, Branch: branch, Against: BranchDiffAgainst{Kind: "item_base", Rev: acceptedPrefix}, Change: file.ChangeType, Hunks: []BranchDiffHunk{}}
		switch file.ChangeType {
		case "added", "modified", "deleted":
		case "renamed":
			if file.OldPath == "" {
				return BranchDiff{}, fmt.Errorf("rename source is unavailable")
			}
			model.Path, model.RenamedTo = file.OldPath, file.Path
		default:
			return BranchDiff{}, fmt.Errorf("unsupported diff change %q", file.ChangeType)
		}
		if file.IsBinary {
			size, ok := binarySizes[file.Path]
			if !ok || size.BeforeBytes < 0 || size.AfterBytes < 0 {
				return BranchDiff{}, &mythicalPRUnavailable{}
			}
			model.Binary = &size
		} else {
			for _, parsed := range parseCommentDiffHunks(file.Patch) {
				hunk := BranchDiffHunk{OldStart: parsed.oldStart, NewStart: parsed.newStart, Lines: []BranchDiffLine{}}
				for _, line := range parsed.body {
					if len(line) > 0 && (line[0] == ' ' || line[0] == '+' || line[0] == '-') {
						hunk.Lines = append(hunk.Lines, BranchDiffLine{Op: line[:1], Text: line[1:]})
					}
				}
				model.Hunks = append(model.Hunks, hunk)
			}
		}
		result.Files = append(result.Files, model)
	}
	return result, nil
}
