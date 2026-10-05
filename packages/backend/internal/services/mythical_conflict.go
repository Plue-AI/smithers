package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A conflict belongs to this rebase, independent of the ordinary attempt
// ladder. Admission and Attempts=1 are saved together; neither a failed run
// nor a repeated sweep can buy another automatic resolution turn.
type mythicalConflict struct {
	Paths    []string  `json:"paths"`
	Onto     string    `json:"onto"`
	Tree     string    `json:"tree"`
	Commit   string    `json:"commit"`
	Run      string    `json:"run,omitempty"`
	Outcome  string    `json:"outcome,omitempty"`
	Head     string    `json:"head,omitempty"`
	DoneHead string    `json:"doneHead,omitempty"`
	Since    time.Time `json:"since"`
}

func conflictPrompt(item db.MythicalItem, paths []string) string {
	// ResolveConflict uses the same precise path task. The stack has no change
	// session trailer: its ordinary source-publication receipt binds the lane.
	encoded, _ := json.Marshal(paths)
	return fmt.Sprintf("Resolve the conflict in paths %s on TODO T%d. Modify only those paths, preserve the intended changes from both sides, run relevant tests, and leave the resolved result on this lane. Do not approve, merge or move main.\n\nOriginal request:\n%s", encoded, mythicalItemNumber(item), todoPrompt(item))
}

func (st *mythicalItemStep) beginConflict(ctx context.Context, item db.MythicalItem, onto string, conflict *errMythicalConflict) (*db.MythicalItem, bool, error) {
	checks := mythicalChecksOf(item)
	if checks.ConflictAttempts >= 1 {
		return conflictWait(item, conflict.Paths, st.now), false, nil
	}
	if item.WorkspaceID == "" || conflict.Tree == "" {
		return mythicalInfraOutage(item, "launch", "the conflicted tree has no lane", st.now), false, nil
	}
	if hold := st.launchable(ctx, item); hold != nil {
		return hold, false, nil
	}
	commit, err := st.r.g.writeCommit(ctx, mythicalCommit{Tree: conflict.Tree, Parents: []string{onto}, Author: mythicalScratchIdentity,
		Committer: mythicalScratchIdentity, ChangeID: mythicalChangeIDFor("conflict", uuidString(item.ID), onto, item.CandidateHead), Message: "Resolve TODO conflict\n"})
	if err != nil {
		return nil, false, err
	}
	ref, err := st.s.retainFor(ctx, st.r, item.WorkspaceID, commit)
	if err != nil {
		return mythicalInfraOutage(item, "launch", err.Error(), st.now), false, nil
	}
	next := item
	next.Generation++
	checks.ConflictAttempts = 1
	checks.Conflict = &mythicalConflict{Paths: append([]string(nil), conflict.Paths...), Onto: onto, Tree: conflict.Tree, Commit: commit, Since: st.now}
	next.Checks = checks.encode()
	next.Integration, _ = json.Marshal(map[string]any{"conflict": checks.Conflict})
	payload, _ := json.Marshal(map[string]any{"prompt": conflictPrompt(item, conflict.Paths), "maxRounds": 1,
		"base": map[string]string{"commitId": commit, "ref": ref}})
	saved, err := st.commitWith(ctx, next, "conflict", "coding/request", payload, func(tx pgx.Tx, saved db.MythicalItem) error {
		return scopeConflictCredentials(ctx, tx, saved, conflict.Paths)
	})
	if err != nil {
		return mythicalInfraOutage(item, "launch", err.Error(), st.now), false, nil
	}
	return &saved, true, nil
}

func conflictWait(item db.MythicalItem, paths []string, now time.Time) *db.MythicalItem {
	next := item
	checks := mythicalChecksOf(item)
	for _, wait := range checks.Waits {
		if wait.Kind == "conflict" && wait.SettledAt == nil {
			return nil
		}
	}
	checks.Waits = append(checks.Waits, TodoWait{ID: "conflict-" + strconv.Itoa(int(item.Generation)), Kind: "conflict", Paths: append([]string(nil), paths...), Prompt: "Resolve conflicts", Since: now})
	next.Checks = checks.encode()
	next.Reason = "Resolve conflicts in " + strings.Join(paths, ", ")
	return &next
}

// A coding host keeps its token across runs. Narrow existing host credentials
// atomically with conflict admission, and mint later hosts with the same paths.
// Person/terminal credentials and the head reporter are separate authorities.
func scopeConflictCredentials(ctx context.Context, tx pgx.Tx, item db.MythicalItem, paths []string) error {
	scopes := boxHostLandingTokenScopes(item.RepositoryID, item.WorkspaceID)
	if len(paths) > 0 {
		scopes = strings.Join(append([]string{string(middleware.ScopeWriteRepository), middleware.RepositoryRestrictionScope(item.RepositoryID), middleware.LandingWorkspaceScope(item.WorkspaceID)}, middleware.PathRestrictionScopes(paths)...), ",")
	}
	_, err := tx.Exec(ctx, `UPDATE access_tokens SET scopes=$1 WHERE system_issued AND name LIKE 'flow-host-landing-%' AND $2=ANY(string_to_array(scopes, ','))`, scopes, middleware.LandingWorkspaceScope(item.WorkspaceID))
	return err
}

func conflictMarkers(content []byte) bool {
	// Git's marker lines, including diff3's base section. Partial edits retain
	// at least one marker; an ordinary substring in source is not a marker.
	for _, line := range strings.Split(string(content), "\n") {
		for _, marker := range []string{"<<<<<<<", "|||||||", "=======", ">>>>>>>"} {
			if line == marker || strings.HasPrefix(line, marker+" ") {
				return true
			}
		}
	}
	return false
}

func (st *mythicalItemStep) conflictHead(ctx context.Context, item db.MythicalItem, head string) (string, error) {
	conflict := mythicalChecksOf(item).Conflict
	if conflict == nil || !mythicalSHA.MatchString(head) {
		return "", &TodoControlError{409, "still_conflicted", "conflict", "Resolve the conflicts first"}
	}
	candidate := item
	candidate.CandidateHead = head
	if err := st.fetchCandidate(ctx, candidate); err != nil {
		return "", err
	}
	ancestor, err := st.r.g.isAncestor(ctx, conflict.Commit, head)
	if err != nil {
		return "", err
	}
	if !ancestor {
		return "", &TodoControlError{409, "still_conflicted", "conflict", "The lane has no resolved result"}
	}
	writes, err := st.r.g.changedPaths(ctx, conflict.Commit, head)
	if err != nil {
		return "", err
	}
	for _, file := range writes {
		if !slices.Contains(conflict.Paths, file) {
			return "", &TodoControlError{409, "conflict_paths", "conflict", "Resolve only the conflicted paths"}
		}
	}
	for _, file := range conflict.Paths {
		existsErr := func() error { _, err := st.r.g.command(ctx, nil, "cat-file", "-e", head+":"+file); return err }()
		if existsErr != nil {
			continue
		}
		content, err := st.r.g.command(ctx, nil, "cat-file", "blob", head+":"+file)
		if err != nil {
			return "", err
		}
		if conflictMarkers(content) {
			return "", &TodoControlError{409, "still_conflicted", "conflict", "Resolve the conflicts first"}
		}
	}
	onto := st.prefix(item)
	if err := st.fetchOnto(ctx, onto); err != nil {
		return "", err
	}
	merged, err := st.r.g.merge3(ctx, conflict.Onto, onto, head)
	var clash *errMythicalConflict
	if errors.As(err, &clash) {
		return "", &TodoControlError{409, "still_conflicted", "conflict", "The prefix still conflicts"}
	}
	if err != nil {
		return "", err
	}
	return st.r.g.writeCommit(ctx, mythicalCommit{Tree: merged, Parents: []string{onto}, Author: mythicalScratchIdentity, Committer: mythicalScratchIdentity,
		ChangeID: mythicalChangeIDFor("resolved", uuidString(item.ID), onto, head), Message: item.Summary + "\n"})
}

func (st *mythicalItemStep) finishConflict(ctx context.Context, item db.MythicalItem) (*db.MythicalItem, bool, error) {
	conflict := mythicalChecksOf(item).Conflict
	if conflict == nil {
		return nil, false, nil
	}
	head := conflict.DoneHead
	if head == "" {
		if conflict.Outcome == "" {
			return nil, false, nil
		}
		if conflict.Outcome != "validated" {
			return conflictWait(item, conflict.Paths, st.now), false, nil
		}
		for _, wait := range todoOpenWaits(item) {
			if wait.Kind == "conflict" {
				return nil, false, nil
			}
		}
		workspace, err := st.q.GetWorkspace(ctx, item.WorkspaceID)
		if err != nil {
			return nil, false, err
		}
		head = conflict.Head
		if head == "" {
			head = workspace.HeadCommitID
		}
	}
	resolved, err := st.conflictHead(ctx, item, head)
	var refusal *TodoControlError
	if errors.As(err, &refusal) {
		return conflictWait(item, conflict.Paths, st.now), false, nil
	}
	if err != nil {
		return mythicalInfraOutage(item, "launch", err.Error(), st.now), false, nil
	}
	next := item
	checks := mythicalChecksOf(next)
	checks.Conflict = nil
	next.Checks = checks.encode()
	return st.verifyRebased(ctx, next, st.prefix(item), resolved)
}

// Done uses the same answer service, but validates the lane's immutable
// published head and merge before settling a conflict wait. Reads of Git
// objects do not move any ref; the stack worker alone advances the item.
func (s *MythicalService) checkConflictDone(ctx context.Context, q *db.Queries, item db.MythicalItem) (string, error) {
	workspace, err := q.GetWorkspace(ctx, item.WorkspaceID)
	if err != nil {
		return "", err
	}
	repository, err := q.GetRepoByID(ctx, item.RepositoryID)
	if err != nil {
		return "", err
	}
	owner, err := mythicalRepositoryOwner(ctx, q, repository)
	if err != nil {
		return "", err
	}
	stack, err := q.GetMythicalStack(ctx, item.RepositoryID)
	if err != nil {
		return "", err
	}
	g := mythicalGit{dir: filepath.Join(s.scratchRoot, "repo-"+strconv.FormatInt(item.RepositoryID, 10)+".git")}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repository.Name, RepositoryStillAt(q, item.RepositoryID, owner, repository.Name))
	if err != nil {
		return "", err
	}
	defer bridge.Close()
	items, err := q.ListMythicalItems(ctx, item.RepositoryID, 500)
	if err != nil {
		return "", err
	}
	refs, err := g.lsRemote(ctx, bridge.URL())
	if err != nil {
		return "", err
	}
	r := &mythicalRun{row: stack, g: g, bridge: bridge, owner: owner, repo: repository.Name, mainTip: stack.LandedMain, tip: refs[repohost.MythicalBookmarkRef]}
	st := mythicalItemStep{s: s, r: r, q: q, items: items, now: s.now().UTC()}
	if _, err := st.conflictHead(ctx, item, workspace.HeadCommitID); err != nil {
		return "", err
	}
	return workspace.HeadCommitID, nil
}

func (s *MythicalService) doneConflictTodo(ctx context.Context, number int64, input TodoControlInput) (TodoControlReceipt, error) {
	if s == nil || s.store == nil {
		return TodoControlReceipt{}, todoControlUnavailable()
	}
	item, err := s.queries().GetMythicalItemByNumber(ctx, input.Repository, number)
	if err != nil {
		return TodoControlReceipt{}, err
	}
	for _, wait := range mythicalChecksOf(item).Waits {
		if wait.Kind != "conflict" {
			continue
		}
		if wait.SettledAt == nil || wait.Answer == "Done" {
			if err := s.AnswerTodo(ctx, input.Repository, input.Actor, number, TodoAnswerInput{Wait: wait.ID, Answer: "Done"}); err != nil {
				return TodoControlReceipt{}, err
			}
			return TodoControlReceipt{State: "accepted"}, nil
		}
	}
	return TodoControlReceipt{}, todoControlConflict("TODO has no conflict")
}
