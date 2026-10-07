package services

import (
	"context"
	"strings"
	"unicode/utf8"
)

// BranchRebaseInput is the system rebase door. Done names the retained change
// and onto revision; Rebase now never accepts a caller-selected destination.
type BranchRebaseInput struct {
	Rebase         bool   `json:"rebase,omitempty"`
	ConflictChange string `json:"conflict_change,omitempty"`
	OntoRevision   string `json:"onto_revision,omitempty"`
	Request        string `json:"-"`
}

func (in BranchRebaseInput) Validate() error {
	validID := func(value string) bool {
		return value != "" && len(value) <= 128 && utf8.ValidString(value) && !strings.ContainsAny(value, " \t\r\n\x00")
	}
	if len(in.Request) > 256 || (in.Rebase && (in.ConflictChange != "" || in.OntoRevision != "")) ||
		(!in.Rebase && (!validID(in.ConflictChange) || !validID(in.OntoRevision))) {
		return &BranchError{400, "invalid_rebase", "user", "Invalid rebase request"}
	}
	return nil
}

// RebaseBranch is intentionally refused before effects until the native
// daemon boundary supplies conflict materialization, unresolved-path validation
// and recovery of a fenced rewrite. Rebase's head-only RPC is insufficient:
// treating a capture or host merge as that receipt would lose a conflict.
func (s *MythicalService) RebaseBranch(ctx context.Context, repository, actor int64, branch string, input BranchRebaseInput) (TodoControlReceipt, error) {
	if err := input.Validate(); err != nil {
		return TodoControlReceipt{}, err
	}
	if branch == "" || len(branch) > 1024 || strings.ContainsAny(branch, "\x00\r\n") {
		return TodoControlReceipt{}, &BranchError{400, "invalid_branch", "user", "Invalid branch"}
	}
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, &BranchError{503, "rebase_unavailable", "infra", "Rebase unavailable"}
	}
	command := "branch.rebase"
	if input.Rebase {
		command = "branch.rebase-now"
	}
	decision, err := Authorize(ctx, s.queries(), command)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	resolved, err := InstallRepositoryID(ctx, s.queries())
	if err != nil {
		return TodoControlReceipt{}, err
	}
	if decision.UserID != actor || resolved != repository {
		return TodoControlReceipt{}, &BranchError{403, "permission", "permission", "Access denied"}
	}
	// Refuse machine/run authority even when a caller bypasses the HTTP route.
	if _, err := todoRequestCredential(ctx, actor); err != nil {
		return TodoControlReceipt{}, err
	}
	return TodoControlReceipt{}, &BranchError{503, "rebase_execution_unavailable", "infra", "Rebase execution unavailable"}
}
