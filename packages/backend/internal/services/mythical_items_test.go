package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// fakeMythicalGitHub is GitHub for the stack: a real bare repository the
// proposal is pushed to, plus recorded issues and pull requests.
type fakeMythicalGitHub struct {
	mu     sync.Mutex
	dir    string
	issues []mythicalIssue
	pulls  map[int64]*mythicalPull
	// botWritten issues were last written by a non-maintainer; the rest by
	// their maintainer authors.
	botWritten map[int64]bool
	// readOnly accounts are not maintainers; every other account is.
	readOnly map[string]bool
	// unanswered issues' writers GitHub does not answer for.
	unanswered map[int64]bool
	// merges are the heads Merge merged, by pull request; removed the labels
	// RemoveLabel took off, as "#<issue> <label>".
	merges  map[int64]string
	removed []string
	// labelers applied an issue's labels; absent, its author did; viaApp
	// marks an application an App made.
	labelers map[int64]string
	viaApp   map[int64]bool
	// labelEvents is the live labeled event per "<issue>/<label>", as a
	// label event recorded it (o.labeled); it answers ahead of labelers.
	labelEvents map[string]mythicalLabelApplier
	labelSeq    int64
	// comments are the issue comments Comment posted, as "#<issue> <body>",
	// one per "#<issue> <key>" (commentKeys, in the same order); added the
	// labels AddLabel put on, as "#<issue> <label>"; closed the issues
	// CloseIssue closed, in order.
	comments    []string
	commentKeys []string
	added       []string
	closed      []int64
	// ci is GitHub CI's verdict per commit; absent is green. commentErr
	// fails every Comment; closeErr every CloseIssue.
	ci         map[string]string
	commentErr error
	// accounts are the GitHub accounts Account answers, by numeric id.
	accounts map[int64]gitHubActor
	closeErr error
}

// MergeToken answers a token the fake does not check.
func (g *fakeMythicalGitHub) MergeToken(context.Context, mythicalGitHubRepo) (GitHubInstallationToken, error) {
	return GitHubInstallationToken{InstallationID: 1, Token: "merge-token"}, nil
}

// Merge squash-merges like GitHub: only while the pull request is open and
// its branch head is still head.
func (g *fakeMythicalGitHub) Merge(_ context.Context, _ mythicalGitHubRepo, _ string, number int64, head string, _ mythicalMergeCommitText) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull, ok := g.pulls[number]
	if !ok || pull.State != "open" {
		return "", fmt.Errorf("pull %d is not open", number)
	}
	out, err := exec.Command("git", "--git-dir", g.dir, "rev-parse", "refs/heads/"+pull.HeadRef).Output()
	if err != nil || strings.TrimSpace(string(out)) != head {
		return "", errors.New("GitHub refused to merge pull requests (HTTP 409)")
	}
	if g.merges == nil {
		g.merges = map[int64]string{}
	}
	g.merges[number] = head
	pull.Merged, pull.State, pull.MergeCommit = true, "closed", "squash-of-"+head
	return pull.MergeCommit, nil
}

// LabelApplier answers the live labeled event a label event recorded, else
// labelers[number], else the issue's author, else roninjin10; viaApp marks
// an App's application.
func (g *fakeMythicalGitHub) LabelApplier(_ context.Context, _ mythicalGitHubRepo, number int64, label string) (*mythicalLabelApplier, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if event, ok := g.labelEvents[fmt.Sprintf("%d/%s", number, label)]; ok {
		return &event, nil
	}
	login := "roninjin10"
	for _, issue := range g.issues {
		if issue.Number == number && issue.Author.Login != "" {
			login = issue.Author.Login
		}
	}
	if applier, ok := g.labelers[number]; ok {
		login = applier
	}
	return &mythicalLabelApplier{Actor: gitHubActor{Login: login}, ViaApp: g.viaApp[number]}, nil
}

// Comment posts once per key, as GitHub with the keyed comment does: a
// second say of a key edits the comment it posted; without a key every call
// posts.
func (g *fakeMythicalGitHub) Comment(_ context.Context, _ mythicalGitHubRepo, number int64, key, body string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.commentErr != nil {
		return g.commentErr
	}
	keyed := fmt.Sprintf("#%d %s", number, key)
	for i, seen := range g.commentKeys {
		if key != "" && seen == keyed {
			g.comments[i] = fmt.Sprintf("#%d %s", number, body)
			return nil
		}
	}
	g.commentKeys = append(g.commentKeys, keyed)
	g.comments = append(g.comments, fmt.Sprintf("#%d %s", number, body))
	return nil
}

func (g *fakeMythicalGitHub) CloseIssue(_ context.Context, _ mythicalGitHubRepo, number int64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closeErr != nil {
		return g.closeErr
	}
	g.closed = append(g.closed, number)
	for i := range g.issues {
		if g.issues[i].Number == number {
			g.issues[i].State = "closed"
		}
	}
	return nil
}

// OnMain reads the fake's own main: a commit it does not hold is not on it.
func (g *fakeMythicalGitHub) OnMain(_ context.Context, _ mythicalGitHubRepo, bookmark, commit string) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	err := exec.Command("git", "--git-dir", g.dir, "merge-base", "--is-ancestor", commit, "refs/heads/"+bookmark).Run()
	return err == nil, nil
}

// HeadChecks answers ci[sha], or green when the test set none.
func (g *fakeMythicalGitHub) HeadChecks(_ context.Context, _ mythicalGitHubRepo, sha string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if verdict, ok := g.ci[sha]; ok {
		return verdict, nil
	}
	return mythicalCIGreen, nil
}

func (g *fakeMythicalGitHub) AddLabel(_ context.Context, _ mythicalGitHubRepo, number int64, label string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.added = append(g.added, fmt.Sprintf("#%d %s", number, label))
	return nil
}

func (g *fakeMythicalGitHub) RemoveLabel(_ context.Context, _ mythicalGitHubRepo, number int64, label string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.removed = append(g.removed, fmt.Sprintf("#%d %s", number, label))
	return nil
}

// pagedMythicalGitHub uses the real issue listing while retaining the fixture's
// local Git repository and admission behavior.
type pagedMythicalGitHub struct {
	*fakeMythicalGitHub
	api *mythicalGitHubAPI
}

func (g *pagedMythicalGitHub) OpenIssues(ctx context.Context, gh mythicalGitHubRepo) ([]mythicalIssue, error) {
	return g.api.OpenIssues(ctx, gh)
}

func (g *fakeMythicalGitHub) Maintainer(_ context.Context, _ mythicalGitHubRepo, account gitHubActor) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.readOnly[account.Login], nil
}

// MaintainerNow answers as Maintainer: this fake remembers nothing.
func (g *fakeMythicalGitHub) MaintainerNow(ctx context.Context, gh mythicalGitHubRepo, account gitHubActor) (bool, error) {
	return g.Maintainer(ctx, gh, account)
}

// IssueTextByMaintainer reads a listed issue's TextByMaintainer as its
// author's standing, and botWritten as its last writer.
func (g *fakeMythicalGitHub) IssueTextByMaintainer(_ context.Context, _ mythicalGitHubRepo, issue mythicalIssue) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.unanswered[issue.Number] {
		return false, errGitHubIssueTextUnavailable
	}
	return issue.TextByMaintainer && !g.botWritten[issue.Number], nil
}

func (g *fakeMythicalGitHub) Resolve(context.Context, db.Repository, string, int64) (mythicalGitHubRepo, error) {
	return mythicalGitHubRepo{Owner: "smithersai", Name: "smithers", Token: "t", GitURL: g.dir}, nil
}

func (g *fakeMythicalGitHub) OpenIssues(context.Context, mythicalGitHubRepo) ([]mythicalIssue, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]mythicalIssue(nil), g.issues...), nil
}

// Issue answers the issue as listed, or GitHub's 404.
func (g *fakeMythicalGitHub) Issue(_ context.Context, _ mythicalGitHubRepo, number int64) (mythicalIssue, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, issue := range g.issues {
		if issue.Number == number {
			return issue, nil
		}
	}
	return mythicalIssue{}, landingGitHubStatusError(http.StatusNotFound, "smithersai", "smithers", "read issues")
}

// Pull answers the pull request with its branch's head as GitHub reads it.
func (g *fakeMythicalGitHub) Pull(_ context.Context, _ mythicalGitHubRepo, number int64) (mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull, ok := g.pulls[number]
	if !ok {
		return mythicalPull{}, fmt.Errorf("no pull %d", number)
	}
	answer := *pull
	if out, err := exec.Command("git", "--git-dir", g.dir, "rev-parse", "refs/heads/"+pull.HeadRef).Output(); err == nil && !pull.Merged {
		answer.HeadSHA = strings.TrimSpace(string(out))
	}
	return answer, nil
}

// ClosePull closes the pull request unmerged, as Drop does.
func (g *fakeMythicalGitHub) ClosePull(_ context.Context, _ mythicalGitHubRepo, number int64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull, ok := g.pulls[number]
	if !ok {
		return fmt.Errorf("no pull %d", number)
	}
	pull.State = "closed"
	return nil
}

func (g *fakeMythicalGitHub) FindPull(_ context.Context, _ mythicalGitHubRepo, branch string) (*mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, pull := range g.pulls {
		if pull.HeadRef == branch {
			found := *pull
			return &found, nil
		}
	}
	return nil, nil
}

func (g *fakeMythicalGitHub) CreatePull(_ context.Context, _ mythicalGitHubRepo, title, head, base, body string, draft bool) (mythicalPull, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pulls == nil {
		g.pulls = map[int64]*mythicalPull{}
	}
	number := int64(100 + len(g.pulls))
	pull := &mythicalPull{Number: number, URL: "https://github.com/smithersai/smithers/pull/" + strconv.FormatInt(number, 10), State: "open", HeadRef: head, Body: body}
	g.pulls[pull.Number] = pull
	return *pull, nil
}

func (g *fakeMythicalGitHub) UpdatePullBody(_ context.Context, _ mythicalGitHubRepo, number int64, body string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull, ok := g.pulls[number]
	if !ok {
		return fmt.Errorf("no pull %d", number)
	}
	pull.Body = body
	return nil
}

func (g *fakeMythicalGitHub) merge(number int64, commit string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	pull := g.pulls[number]
	pull.Merged, pull.State, pull.MergeCommit = true, "closed", commit
}

// maintainerTodo is a maintainer person applying the todo label.
var maintainerTodo = gitHubLabelApplication{Label: todoLabel, ByMaintainer: true}

type fakeMythicalLauncher struct {
	mu       sync.Mutex
	requests []flowdispatch.LaunchRequest
	fail     int
	// cancelled are the request ids CancelRequestInTx cancelled.
	cancelled []string
}

// AdmitInTx records the launch only when the item's transaction commits, as
// flowdispatch does; fail makes the next admission fail (a lost launch).
func (l *fakeMythicalLauncher) AdmitInTx(ctx context.Context, tx pgx.Tx, request flowdispatch.LaunchRequest) (jobs.RequestReceipt, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail > 0 {
		l.fail--
		return jobs.RequestReceipt{}, errors.New("dispatch unavailable")
	}
	for _, seen := range l.requests {
		if seen.RequestID == request.RequestID {
			return jobs.RequestReceipt{}, errors.New("duplicate launch " + request.RequestID)
		}
	}
	l.requests = append(l.requests, request)
	return jobs.RequestReceipt{}, nil
}

// CancelRequestInTx records the cancellation of an admitted launch, as
// flowdispatch does in the caller's transaction; an unknown request is
// jobs.ErrNotFound.
func (l *fakeMythicalLauncher) CancelRequestInTx(_ context.Context, _ pgx.Tx, _ jobs.Scope, requestID string) (jobs.Operation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, seen := range l.requests {
		if seen.RequestID == requestID {
			l.cancelled = append(l.cancelled, requestID)
			return jobs.Operation{}, nil
		}
	}
	return jobs.Operation{}, jobs.ErrNotFound
}

func (l *fakeMythicalLauncher) last(flowID string) flowdispatch.LaunchRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.requests) - 1; i >= 0; i-- {
		if l.requests[i].FlowID == flowID {
			return l.requests[i]
		}
	}
	return flowdispatch.LaunchRequest{}
}

// all are the launches of flowID, in order.
func (l *fakeMythicalLauncher) all(flowID string) []flowdispatch.LaunchRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []flowdispatch.LaunchRequest
	for _, request := range l.requests {
		if request.FlowID == flowID {
			out = append(out, request)
		}
	}
	return out
}

type fakeMythicalLanes struct {
	mu      sync.Mutex
	created []string
	deleted []string
	owned   map[string]bool
	// provision observes a bound lane where the real lanes start its box.
	provision func(id string)
	narrowed  []string
	// offer is the lane machine Offer answers (a 2 vCPU, 4096 MiB container
	// machine when unset), and placements the placement of every lane created.
	offer      *mythicalMachineOffer
	offerErr   error
	placements []MythicalPlacement
}

func (l *fakeMythicalLanes) Create(_ context.Context, _ db.Repository, _ string, _ int64, name string, placement MythicalPlacement, bind func(string) error) (string, error) {
	id := uuid.NewString()
	if err := bind(id); err != nil {
		return "", err
	}
	if l.provision != nil {
		l.provision(id)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.created = append(l.created, id)
	l.placements = append(l.placements, placement)
	return id, nil
}

// Placed compares a lane's recorded placement the way the real lanes compare
// its workspace: kind, and closure for a NixOS lane.
func (l *fakeMythicalLanes) Placed(_ context.Context, id string, placement MythicalPlacement) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, created := range l.created {
		if created == id {
			was := l.placements[i]
			kind := normalizeWorkspaceKind(placement.Kind)
			return normalizeWorkspaceKind(was.Kind) == kind && (kind != "vm" || was.ClosureHash == placement.ClosureHash), nil
		}
	}
	return true, nil
}

func (l *fakeMythicalLanes) Offer(context.Context, int64) (mythicalMachineOffer, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.offerErr != nil {
		return mythicalMachineOffer{}, l.offerErr
	}
	if l.offer != nil {
		return *l.offer, nil
	}
	return mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096}, nil
}

func (l *fakeMythicalLanes) NarrowOutsiderEgress(_ context.Context, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.narrowed = append(l.narrowed, id)
	return nil
}

func (l *fakeMythicalLanes) Owned(_ context.Context, _, _ int64, id string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.owned[id], nil
}

func (l *fakeMythicalLanes) Delete(_ context.Context, _, _ int64, id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.deleted = append(l.deleted, id)
	return nil
}

type mythicalOrchestration struct {
	*mythicalServiceFixture
	github   *fakeMythicalGitHub
	launcher *fakeMythicalLauncher
	lanes    *fakeMythicalLanes
}

func newMythicalOrchestration(t *testing.T) *mythicalOrchestration {
	f := newMythicalServiceFixture(t)
	f.commit("✨ feat: one", "a.txt", "a\n")
	f.commit("✨ feat: two", "b.txt", "b\n")
	f.publish()
	github := &fakeMythicalGitHub{dir: f.bare("github.git")}
	f.git(f.work, "push", "-q", github.dir, "main:refs/heads/main")
	o := &mythicalOrchestration{mythicalServiceFixture: f, github: github, launcher: &fakeMythicalLauncher{}, lanes: &fakeMythicalLanes{}}
	f.service.SetOrchestration(github, o.launcher, o.lanes)
	// The install's composition admits TODOs; the fixture composes it so.
	f.service.EnableTodoAdmission()
	// Accepted publication fixtures stand in for the not-yet-installed provider.
	f.service.prFacts = func(_ context.Context, item db.MythicalItem) (mythicalPRShape, error) {
		return mythicalPRShape{Branch: fmt.Sprintf("smithers/todo-%d", item.IssueNumber.Int64), Title: item.IssueTitle, Prompt: item.IssueBody, Acceptance: "Fixture acceptance", Evidence: "Fixture evidence", DiffStat: "Fixture diff stat", Review: "Fixture review", URL: "http://localhost/todos/fixture", Owner: "ben", First: true, FixesIssue: true, DraftsAvailable: true}, nil
	}
	// The owner's policy names roninjin10; no issue is a TODO on its own
	// unless a test sets todoSince.
	f.service.SetPolicyReader(policyHost{mythicalPolicy("")})
	_, err := f.service.RequestBootstrap(context.Background(), f.repoID, f.userID, 100, false)
	require.NoError(t, err)
	row := f.poll()
	require.Equal(t, "active", row.State, row.LastError)
	return o
}

func (o *mythicalOrchestration) item(number int64) db.MythicalItem {
	o.t.Helper()
	item, err := db.New(o.pool).GetMythicalItemByIssue(context.Background(), o.repoID, number)
	require.NoError(o.t, err)
	return item
}

// wake makes the stack and every item due and runs one claim.
func (o *mythicalOrchestration) wake() db.MythicalStack {
	o.t.Helper()
	const pollTimeout = 30 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), pollTimeout)
	defer cancel()
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(o.t, err)
	o.service.MainMoved(ctx, o.repoID)
	err = o.service.PollOnce(ctx)
	require.NoError(o.t, ctx.Err(), "mythical orchestration poll exceeded %s", pollTimeout)
	require.NoError(o.t, err)
	row, err := db.New(o.pool).GetMythicalStack(ctx, o.repoID)
	require.NoError(o.t, err)
	return row
}

// project answers a launched run's terminal outcome, as flowdispatch would.
func (o *mythicalOrchestration) project(request flowdispatch.LaunchRequest, state jobs.State, runID, output string) {
	o.t.Helper()
	update := flowdispatch.ProjectionUpdate{State: state, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, RunID: runID,
		Run: &flowruntime.FlowRuntimeRun{RunID: runID, FinalOutput: &output}}}
	require.NoError(o.t, o.service.ProjectFlowRuntime(context.Background(), update))
}

// answerReviews answers every review launched so far with output, as the
// review flow would, and runs one claim. A review already answered, or of
// an older generation, changes nothing.
func (o *mythicalOrchestration) answerReviews(output string) {
	o.t.Helper()
	o.launcher.mu.Lock()
	requests := append([]flowdispatch.LaunchRequest(nil), o.launcher.requests...)
	o.launcher.mu.Unlock()
	for i, request := range requests {
		if request.FlowID == mythicalReviewFlow {
			o.project(request, jobs.StateCompleted, fmt.Sprintf("run-review-%d", i), output)
		}
	}
	o.wake()
}

// laneResult writes a candidate on base, as a lane's coding host publishes
// it: an ordinary commit retained in the lane workspace's source ref.
func (o *mythicalOrchestration) laneResult(workspaceID, base string, files map[string]string, message string) string {
	o.t.Helper()
	index := filepath.Join(o.t.TempDir(), "index")
	run := func(stdin string, args ...string) string {
		cmd := exec.Command("git", append([]string{"--git-dir", o.hostDir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+index, "GIT_AUTHOR_NAME=Lane", "GIT_AUTHOR_EMAIL=lane@example.com",
			"GIT_COMMITTER_NAME=Lane", "GIT_COMMITTER_EMAIL=lane@example.com", "GIT_AUTHOR_DATE=2026-09-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-09-01T00:00:00Z")
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		require.NoError(o.t, err, "git %v: %s", args, out)
		return strings.TrimSpace(string(out))
	}
	run("", "read-tree", base)
	for path, content := range files {
		blob := run(content, "hash-object", "-w", "--stdin")
		run("", "update-index", "--add", "--cacheinfo", "100644,"+blob+","+path)
	}
	tree := run("", "write-tree")
	commit := run("", "commit-tree", tree, "-p", base, "-m", message)
	run("", "update-ref", repohost.WorkspaceSourceRef(workspaceID, commit), commit)
	return commit
}

const validatedRequest = `{"plan":{"changes":[{"title":"Docs","atoms":[{"changeId":null,"message":"📝 docs: add docs"}],
"checks":[{"id":"fast","target":"flows","flow":"checks/fast","flowDigest":"f","tier":"fast","required":true}]}]},
"outcome":{"status":"validated"}}`

func TestMythicalSnapshotPendingAndItemUpdatedAt(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	q := db.New(o.pool)
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{
		Number: 7, Title: "Docs", URL: "https://github.com/smithersai/smithers/issues/7",
		State: "open", TextByMaintainer: true, Body: "Docs", Labels: []string{"todo"},
	}, maintainerTodo))
	item := o.item(7)
	changes, err := q.ListMythicalChanges(ctx, o.repoID)
	require.NoError(t, err)
	require.NotEmpty(t, changes)
	main := changes[len(changes)-1]
	_, err = o.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main = $2, updated_at = NOW() - interval '1 day' WHERE repository_id = $1`,
		o.repoID, main.CommitID)
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET updated_at = NOW() - interval '1 day' WHERE id = $1`, item.ID)
	require.NoError(t, err)
	require.NoError(t, q.ReplaceMythicalChanges(ctx, o.repoID, main.Position+1, []db.MythicalChange{{
		Position: main.Position + 1, ChangeID: "pending-change", CommitID: "pending-commit",
		Title: "Docs", Kind: "item", ItemID: item.ID,
	}}))
	snapshot := func() MythicalStackView {
		t.Helper()
		view, err := o.service.Snapshot(ctx, o.repoID, "owner/repo", "", MythicalViewer{})
		require.NoError(t, err)
		return view
	}
	before := snapshot()
	require.Equal(t, "pending", before.Changes[0].State)
	require.Equal(t, "landed", before.Changes[1].State)
	item = o.item(7)
	item.Reason = "saved"
	_, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	after := snapshot()
	require.Equal(t, before.Generation, after.Generation, "generation counts stack writes only")
	require.Greater(t, after.UpdatedAt, before.UpdatedAt, "item saves advance snapshot time")
	_, err = o.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main = $2 WHERE repository_id = $1`,
		o.repoID, "pending-commit")
	require.NoError(t, err)
	require.Equal(t, "landed", snapshot().Changes[0].State)
}

func TestMythicalItemsFlowFromIssueToLandedAndAdopted(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 7, Title: "Add docs", URL: "https://github.com/smithersai/smithers/issues/7",
		State: "open", TextByMaintainer: true, Body: "Please add a docs page.", Labels: []string{"todo"}}, maintainerTodo))
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 8, Title: "Drive-by", State: "open"}, gitHubLabelApplication{}))
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 9, Title: "A PR", State: "open", PullRequest: true}, gitHubLabelApplication{}))
	assert.Equal(t, "queued", o.item(7).State)
	assert.Equal(t, "skipped", o.item(8).State)
	assert.Contains(t, o.item(8).Reason, "todo label")
	assert.Equal(t, "skipped", o.item(9).State)

	// A lane starts: a fresh workspace, main retained into its source ref,
	// and coding/request launched on the stack.
	stack := o.wake()
	item := o.item(7)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 1)
	assert.EqualValues(t, 0, item.Lane.Int32, "the first lane is lane 0")
	require.True(t, item.LaneStartedAt.Valid)
	assert.WithinDuration(t, time.Now(), item.LaneStartedAt.Time, time.Minute)
	workspace := o.lanes.created[0]
	request := o.launcher.last("coding/request")
	require.Equal(t, mythicalBindingKind, request.Target.BindingKind)
	assert.Equal(t, workspace, request.Target.WorkspaceID)
	assert.Equal(t, flowdispatch.ApprovalAuto, request.ApprovalPolicy)
	var payload struct {
		Prompt string `json:"prompt"`
		Base   struct {
			CommitID string `json:"commitId"`
			Ref      string `json:"ref"`
		} `json:"base"`
	}
	require.NoError(t, json.Unmarshal(request.Payload, &payload))
	assert.Equal(t, stack.LandedMain, payload.Base.CommitID)
	assert.Equal(t, repohost.WorkspaceSourceRef(workspace, stack.LandedMain), payload.Base.Ref)
	assert.Equal(t, stack.LandedMain, o.hostRef(payload.Base.Ref), "the tip is retained where the lane's import reads it")
	assert.Contains(t, payload.Prompt, "#7: Add docs")
	assert.NotContains(t, payload.Prompt, "#8 Drive-by", "an unapproved title never reaches a lane")
	assert.NotContains(t, payload.Prompt, "https://github.com/", "the lane works from the approved text, not a link to the live issue")
	assert.Contains(t, payload.Prompt, "approved text")

	// A duplicate launch is impossible: the lane is busy until the run settles.
	o.wake()
	assert.Len(t, o.launcher.requests, 1)

	// The request validates; its plan is projected and vibe is launched.
	o.project(request, jobs.StateCompleted, "run-request", validatedRequest)
	o.wake()
	item = o.item(7)
	require.Equal(t, "delivering", item.State, item.Reason)
	var plan struct {
		Appends int               `json:"appends"`
		Checks  []json.RawMessage `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(item.Plan, &plan))
	assert.Equal(t, 1, plan.Appends)
	assert.Len(t, plan.Checks, 1)
	vibe := o.launcher.last("coding/vibe")
	assert.JSONEq(t, `{"requestExecutionId":"run-request"}`, string(vibe.Payload))

	// The lane hands its cleaned result to the stack.
	candidate := o.laneResult(workspace, stack.LandedMain, map[string]string{"docs.md": "docs\n"}, "📝 docs: add docs")
	receipt, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: workspace, Base: stack.LandedMain,
		Source: candidate, RequestRunID: "run-request", Summary: "📝 docs: add docs\n\nAdds the docs page."})
	require.NoError(t, err)
	assert.Equal(t, "integrating", receipt.State)
	again, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: workspace, Base: stack.LandedMain,
		Source: candidate, RequestRunID: "run-request", Summary: "📝 docs: add docs"})
	require.NoError(t, err)
	assert.Equal(t, receipt.ItemID, again.ItemID, "a replayed submission is idempotent")

	// Built on the tip: it is proposed as is, as one commit on main whose tree
	// is exactly the candidate's.
	o.wake()
	require.Equal(t, "proposing", o.item(7).State)
	assert.Equal(t, candidate, o.hostRef(repohost.MythicalReservedRefNS+"keep/"+candidate), "the candidate is pinned")
	o.wake()
	item = o.item(7)
	require.Equal(t, "proposed", item.State, item.Reason)
	require.True(t, item.PRNumber.Valid)
	branchHead := o.git(o.github.dir, "rev-parse", "refs/heads/smithers/todo-7")
	assert.Equal(t, o.hostTree(candidate), o.git(o.github.dir, "rev-parse", branchHead+"^{tree}"))
	assert.Equal(t, o.git(o.github.dir, "rev-parse", "refs/heads/main"), o.git(o.github.dir, "rev-parse", branchHead+"^"))
	message := o.git(o.github.dir, "log", "-1", "--format=%B", branchHead)
	assert.Contains(t, message, "Refs #7")
	assert.NotContains(t, message, "Closes #7", "the merge never closes the issue ahead of its completion evidence")

	// change.opened: the review reads the pull request's diff on a fresh
	// lane of the stack's own bookmark, never the box the coding agent wrote
	// to, which is retired first; the review lane stays bound until it
	// answers.
	review := o.launcher.last(mythicalReviewFlow)
	assert.NotEqual(t, workspace, review.Target.WorkspaceID)
	assert.Contains(t, o.lanes.deleted, workspace)
	reviewLane := review.Target.WorkspaceID
	assert.Contains(t, o.lanes.created, reviewLane)
	var args struct {
		Args string `json:"args"`
	}
	require.NoError(t, json.Unmarshal(review.Payload, &args))
	assert.Contains(t, args.Args, "Pull request #"+strconv.FormatInt(item.PRNumber.Int64, 10)+".\n\n<untrusted-title>\nAdd docs\n</untrusted-title>")
	assert.Contains(t, args.Args, "<untrusted-diff>\n")
	assert.Contains(t, args.Args, "+++ b/docs.md")
	assert.NotContains(t, o.lanes.deleted, reviewLane)
	o.answerReviews(`"approve\n- docs.md reads well"`)
	item = o.item(7)
	assert.Equal(t, mythicalReview{Head: item.PRHead, Candidate: item.CandidateHead, RunID: "run-review-2", Verdict: "approve"}, *mythicalChecksOf(item).Review)
	assert.Contains(t, currentTodoEvidence(item).Items, map[string]any{"kind": "review", "summary": "approve"}, "the evidence holds the review of the head that published the candidate")
	assert.Contains(t, o.lanes.deleted, reviewLane, "the review lane is retired once it answers")
	assert.Empty(t, o.github.merges, "an approved TODO without automerge waits for a person")
	assert.Equal(t, "proposed", item.State)

	// The owner squash-merges on GitHub; the main pull brings it to Smithers.
	o.git(o.work, "pull", "-q", "--ff-only", o.github.dir, "main")
	o.git(o.work, "fetch", "-q", o.github.dir, "refs/heads/smithers/todo-7")
	o.git(o.work, "merge", "-q", "--squash", branchHead)
	o.git(o.work, "commit", "-q", "-m", "📝 docs: add docs (#101)")
	merged := o.publish()
	o.github.merge(item.PRNumber.Int64, merged)
	// A person took the item's run over for a while: the adopted change's note names them.
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET checks = COALESCE(checks, '{}'::jsonb) || '{"drivers":[{"by":"will","run":"run_7","from":"2026-09-28T14:02:00Z","to":"2026-09-28T14:09:00Z","messages":3}]}'::jsonb WHERE id = $1`, item.ID)
	require.NoError(t, err)
	stack = o.wake()
	require.Equal(t, "active", stack.State, stack.LastError)
	assert.Equal(t, merged, stack.LandedMain)
	assert.Equal(t, "landed", o.item(7).State)
	assert.Contains(t, o.git(o.hostDir, "cat-file", "-p", stack.NotesCommit+":"+stack.TipCommit),
		"drivers:\n  - by: \"will\"\n    run: \"run_7\"\n    from: \"2026-09-28T14:02:00Z\"\n    to: \"2026-09-28T14:09:00Z\"\n    messages: 3\n")
	assert.Equal(t, o.hostTree(merged), o.hostTree(stack.TipCommit))
	// The fold adopted the item's own change instead of a flat copy.
	changes, err := db.New(o.pool).ListRecentMythicalChanges(ctx, o.repoID, 1)
	require.NoError(t, err)
	require.Len(t, changes, 1)
	assert.Equal(t, "item", changes[0].Kind)
	assert.Equal(t, "Add docs", changes[0].Title)
	assert.EqualValues(t, 7, changes[0].IssueNumber.Int64)
	assert.Equal(t, merged, changes[0].FoldedFrom)

	// The issue hears of the landing only once GitHub main carries the merge
	// commit: the fold alone is not evidence.
	assert.Empty(t, o.github.comments, "no evidence before the commit is on GitHub main")
	assert.Empty(t, o.github.closed, "no close before the commit is on GitHub main")
	o.git(o.work, "push", "-q", o.github.dir, "main:refs/heads/main")
	o.github.closeErr = errors.New("GitHub is down")
	o.wake()
	require.Equal(t, []string{"#7 Landed on main: https://github.com/smithersai/smithers/commit/" + merged +
		"\nChecks: CI green on " + short(item.PRHead) + "; review approve\nRun: run-request"}, o.github.comments, "built on the tip, the item was never re-verified")
	assert.Empty(t, o.github.closed, "the comment is on the issue before any close")
	completion := mythicalChecksOf(o.item(7)).Completion
	require.NotNil(t, completion)
	assert.Equal(t, mythicalCompletion{Commit: merged, Since: completion.Since}, *completion, "open until GitHub closes the issue")
	// The close is retried; the comment is not repeated.
	o.github.closeErr = nil
	o.wake()
	assert.Len(t, o.github.comments, 1, "one completion comment across retries")
	assert.Equal(t, []int64{7}, o.github.closed)
	assert.Equal(t, mythicalCompletionClosed, mythicalChecksOf(o.item(7)).Completion.Outcome)
	assert.Equal(t, "landed", o.item(7).State)
	o.wake()
	assert.Len(t, o.github.comments, 1)
	assert.Equal(t, []int64{7}, o.github.closed, "closed once")
	// GitHub's own report of the close changes nothing about the landed item.
	closed := mythicalIssue{Number: 7, Title: "Add docs", Body: "approved text", State: "closed", TextByMaintainer: true, Labels: []string{"todo"}}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, closed, gitHubLabelApplication{}))
	assert.Equal(t, "landed", o.item(7).State)
}

func TestMythicalItemsRebaseVerifyRetryAndDecline(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	for _, number := range []int64{11, 12, 13} {
		require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: number, Title: fmt.Sprintf("Issue %d", number),
			State: "open", TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	}
	// Four lanes: one stays reserved for direct chat work, so three issues run.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_stacks SET max_parallel = 4 WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	stack := o.wake()
	// Each lane starts from its prefix (§10.3.2): main's tip, as no earlier
	// item has a verified head yet.
	oldTip := stack.LandedMain
	lanes := map[int32]int64{}
	for _, number := range []int64{11, 12, 13} {
		item := o.item(number)
		require.Equal(t, "running", item.State)
		require.Equal(t, oldTip, item.BaseCommit)
		require.True(t, item.Lane.Valid)
		assert.True(t, item.LaneStartedAt.Valid, "the launch records when the lane started")
		lanes[item.Lane.Int32] = number
	}
	assert.Len(t, lanes, 3, "three items in flight hold three distinct lanes")
	for index := int32(0); index < 3; index++ {
		assert.Contains(t, lanes, index, "the lowest free lanes are taken")
	}
	requests := map[int64]flowdispatch.LaunchRequest{}
	for _, request := range o.launcher.requests {
		var projection mythicalProjection
		require.NoError(t, json.Unmarshal(request.Projection, &projection))
		for _, number := range []int64{11, 12, 13} {
			if uuidString(o.item(number).ID) == projection.ItemID {
				requests[number] = request
			}
		}
	}

	// #13 produces no proposal: failed with its retained reason.
	o.fail(requests[13], "run-13", "user", "coding/Error/declined", `{"_tag":"coding/Error","code":"declined","message":"Already done: README.md has it."}`)
	// #11 and #12 validate and hand results built on the old tip.
	o.project(requests[11], jobs.StateCompleted, "run-11", validatedRequest)
	o.project(requests[12], jobs.StateCompleted, "run-12", validatedRequest)
	o.wake()
	assert.Equal(t, "blocked", o.item(13).State)
	assert.Equal(t, "Already done: README.md has it.", o.item(13).Reason)
	ws11, ws12 := o.item(11).WorkspaceID, o.item(12).WorkspaceID
	appended := o.laneResult(ws11, oldTip, map[string]string{"eleven.txt": "11\n"}, "✨ feat: eleven")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: ws11, Base: oldTip, Source: appended,
		RequestRunID: "run-11", Summary: "✨ feat: eleven"})
	require.NoError(t, err)
	conflicting := o.laneResult(ws12, oldTip, map[string]string{"b.txt": "twelve\n"}, "🐛 fix: twelve")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: ws12, Base: oldTip, Source: conflicting,
		RequestRunID: "run-12", Summary: "🐛 fix: twelve"})
	require.NoError(t, err)

	// Main moves underneath them (an outside commit touching b.txt).
	o.commit("🔧 chore: outside", "b.txt", "outside\n")
	o.publish()
	// One poll folds main, then advances the items against the new tip.
	stack = o.wake()
	require.NotEqual(t, oldTip, stack.LandedMain)

	// #11 only appended: rebased onto main's new tip and sent to coding/verify.
	item := o.item(11)
	require.Equal(t, "verifying", item.State, item.Reason)
	assert.Contains(t, string(item.Integration), "rebased")
	assert.Equal(t, stack.LandedMain, item.CandidateBase)
	assert.NotEqual(t, appended, item.CandidateHead)
	verify := o.launcher.last("coding/verify")
	assert.Contains(t, string(verify.Payload), item.CandidateHead)
	assert.Contains(t, string(verify.Payload), `"checks/fast"`)
	assert.Equal(t, item.CandidateHead, o.hostRef(repohost.WorkspaceSourceRef(ws11, item.CandidateHead)))

	// #12 conflicts with main: it holds its lane, so it rebases at once
	// (never idling against the cap) and goes back to a lane with the paths,
	// attempt 2.
	twelve := o.item(12)
	require.Equal(t, "retrying", twelve.State)
	assert.Contains(t, twelve.Reason, "b.txt")
	assert.Contains(t, string(twelve.Integration), "b.txt")
	assert.Contains(t, string(twelve.Integration), stack.LandedMain, "it rebased onto main's new tip")
	assert.Len(t, o.launcher.all("coding/verify"), 1, "a conflict launches no verification")

	// A stale verify projection (an older generation) changes nothing.
	o.project(requests[11], jobs.StateCompleted, "stale", `{"status":"failed","failed":["fast"]}`)
	assert.Equal(t, "", o.item(11).VerifyOutcome)
	o.project(verify, jobs.StateCompleted, "run-verify", `{"status":"passed","failed":[],"receipts":[]}`)
	o.wake()
	// Verified on main's new tip, #11 is ready to publish. This fixture
	// composes no App publication, so it holds there; publication of a
	// rebased TODO is proven over the GitHub fake (todo_rebase_db_test.go).
	item = o.item(11)
	require.Equal(t, "proposing", item.State, item.Reason)
	assert.True(t, item.CandidateVerified)
	assert.Equal(t, stack.LandedMain, item.CandidateBase)

	// #12's retries run out: one very hard continuation on the last
	// attempt, then blocked, visibly, and a retry re-queues it.
	for attempt := 2; attempt <= mythicalAttempts+1; attempt++ {
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
		require.NoError(t, err)
		o.wake()
		twelve = o.item(12)
		require.Equal(t, "running", twelve.State, twelve.Reason)
		require.EqualValues(t, min(attempt, mythicalAttempts), twelve.Attempt)
		// A plan failure spends an attempt; an outage would not.
		o.fail(o.launcher.last("coding/request"), fmt.Sprintf("run-12-%d", attempt), "factory", "coding/Error/fast_gate", "")
		o.wake()
	}
	twelve = o.item(12)
	assert.Equal(t, "blocked", twelve.State)
	payload := string(o.launcher.last("coding/request").Payload)
	assert.Contains(t, payload, "Append new changes at the head only", "the last attempt appends only")
	// A block the very hard stop typed is a person's to lift, like a
	// planner's decline: an agent's run can re-open neither.
	_, err = o.service.retryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(twelve.ID))
	requireRunCredentialRefused(t, err)
	view, err := o.service.retryItem(ctx, o.repoID, uuidString(twelve.ID))
	require.NoError(t, err)
	assert.Equal(t, "queued", view.State)
	_, err = o.service.retryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(o.item(13).ID))
	requireRunCredentialRefused(t, err)
	assert.Equal(t, "blocked", o.item(13).State)

	o.wake()
	// The snapshot shows the items and their lanes.
	snapshot, err := o.service.Snapshot(ctx, o.repoID, "smithers-canary/smithers", "", MythicalViewer{UserID: o.userID})
	require.NoError(t, err)
	states := map[string]string{}
	for _, row := range snapshot.Items {
		states[row.Issue.Title] = row.State
	}
	assert.Equal(t, map[string]string{"Issue 11": "proposing", "Issue 12": "running", "Issue 13": "blocked"}, states)
	busy := map[string]string{}
	for _, lane := range snapshot.Lanes {
		if lane.State == "busy" {
			busy[lane.WorkspaceID] = lane.StartedAt
		}
	}
	require.Len(t, busy, 2, "#11's lane, retained until it is proposed, and #12's lane both show")
	for workspace, started := range busy {
		assert.NotEmpty(t, started, "lane %s shows when it started", workspace)
	}
	_ = pgtype.UUID{}
}

// A failed plan stays blocked through backfill until a person retries it.
func TestMythicalItemsSurviveFailuresAndStayBound(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()

	// An outsider's issue is approved only by a maintainer's label on that
	// exact text; an edit afterwards needs a new label.
	outsider := mythicalIssue{Number: 21, Title: "Outsider", Body: "do x", State: "open", Labels: []string{"todo"}}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, outsider, gitHubLabelApplication{}))
	assert.Equal(t, "skipped", o.item(21).State, "a label seen only in a sweep may predate an edit")
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, outsider, maintainerTodo))
	assert.Equal(t, "queued", o.item(21).State)
	assert.Equal(t, "do x", o.item(21).IssueBody, "the admitted text is pinned")
	edited := outsider
	edited.Body = "do something else entirely"
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, edited, gitHubLabelApplication{}))
	assert.Equal(t, "skipped", o.item(21).State)
	assert.Contains(t, o.item(21).Reason, "re-applies the todo label")
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, edited, maintainerTodo))
	assert.Equal(t, "queued", o.item(21).State)
	assert.Equal(t, "do something else entirely", o.item(21).IssueBody)

	// A lost launch leaves the item exactly as it was; the next claim
	// launches once, under the attempt's own request id.
	o.launcher.fail = 1
	o.wake()
	assert.Equal(t, "queued", o.item(21).State)
	assert.Empty(t, o.launcher.requests)
	o.wake()
	item := o.item(21)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.launcher.requests, 1)
	assert.Len(t, o.lanes.created, 1, "the bound lane is found again, never duplicated")

	// A lane the sweep retired while its launch kept failing never strands
	// the item: the next attempt binds the next name in the series.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_lanes SET retired_at = NOW() WHERE workspace_id = $1`, item.WorkspaceID)
	require.NoError(t, err)
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET state = 'queued', workspace_id = '', generation = generation - 1, attempt = attempt - 1,
		version = version + 1 WHERE id = $1`, item.ID)
	require.NoError(t, err)
	o.launcher.mu.Lock()
	o.launcher.requests = nil
	o.launcher.mu.Unlock()
	o.wake()
	item = o.item(21)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 2)
	rebound, err := db.New(o.pool).GetMythicalLane(ctx, item.WorkspaceID)
	require.NoError(t, err)
	assert.True(t, strings.HasSuffix(rebound.Name, " r1"), rebound.Name)
	require.Len(t, o.launcher.requests, 1)
	var payload struct {
		Prompt string `json:"prompt"`
	}
	require.NoError(t, json.Unmarshal(o.launcher.requests[0].Payload, &payload))
	assert.Contains(t, payload.Prompt, "<issue>\ndo something else entirely\n</issue>")

	// A result must come from this lane's current run, on its tip, and be
	// retained by the lane workspace itself.
	o.project(o.launcher.requests[0], jobs.StateCompleted, "run-21", validatedRequest)
	o.wake()
	require.Equal(t, "delivering", o.item(21).State)
	stack, err := db.New(o.pool).GetMythicalStack(ctx, o.repoID)
	require.NoError(t, err)
	candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, map[string]string{"x.txt": "x\n"}, "✨ feat: x")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "some-other-run", Summary: "✨ feat: x"})
	require.Error(t, err)
	unretained := strings.Repeat("9", 40)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: unretained, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID+1, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err, "only the stack's account submits")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.NoError(t, err)
	lane := item.WorkspaceID

	// A workspace the stack never bound hands a chat result only when it is
	// a live workspace of the stack's account.
	chat := uuid.NewString()
	chatResult := o.laneResult(chat, stack.TipCommit, map[string]string{"y.txt": "y\n"}, "✨ feat: y")
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.Error(t, err, "an unowned or deleted workspace is not a chat source")
	o.lanes.mu.Lock()
	o.lanes.owned = map[string]bool{chat: true}
	o.lanes.mu.Unlock()
	receipt, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.NoError(t, err)
	assert.Equal(t, "integrating", receipt.State)
	again, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: chat, Base: stack.TipCommit,
		Source: chatResult, RequestRunID: "chat-run", Summary: "✨ feat: y"})
	require.NoError(t, err)
	assert.Equal(t, receipt.ItemID, again.ItemID, "a replayed chat result is one item")

	// A proposal push that landed on GitHub but was never recorded is settled
	// from the branch, not pushed again or blocked.
	o.wake() // integrating -> proposing
	require.Equal(t, "proposing", o.item(21).State)
	item = o.item(21)
	main := o.git(o.github.dir, "rev-parse", "refs/heads/main")
	tree := o.hostTree(candidate)
	head := o.git(o.hostDir, "commit-tree", tree, "-p", main, "-m", "✨ feat: x")
	o.git(o.hostDir, "update-ref", repohost.MythicalReservedRefNS+"keep/"+head, head)
	o.git(o.hostDir, "push", "-q", o.github.dir, head+":refs/heads/smithers/todo-21")
	pending, _ := json.Marshal(mythicalProposalOp{Branch: "smithers/todo-21", Expected: "", Head: head})
	item.PendingOp = pending
	_, err = db.New(o.pool).SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	o.wake()
	item = o.item(21)
	require.Equal(t, "proposed", item.State, item.Reason)
	assert.Equal(t, head, item.PRHead)
	assert.Empty(t, item.PendingOp)

	// A retired lane's results never reach the stack again, as a lane or as chat.
	o.answerReviews(`"approve"`)
	assert.Contains(t, o.lanes.deleted, lane)
	_, err = o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: lane, Base: stack.TipCommit,
		Source: candidate, RequestRunID: "run-21", Summary: "✨ feat: x"})
	require.Error(t, err)

	// A rejected item retried proposes on a new branch, never its closed PR.
	o.github.mu.Lock()
	o.github.pulls[item.PRNumber.Int64].State = "closed"
	o.github.mu.Unlock()
	_, err = o.pool.Exec(ctx, `UPDATE mythical_items SET next_attempt_at = NOW() WHERE repository_id = $1`, o.repoID)
	require.NoError(t, err)
	o.wake()
	require.Equal(t, "rejected", o.item(21).State)
	// The owner closed the PR: only a person retries it.
	_, err = o.service.retryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(item.ID))
	requireRunCredentialRefused(t, err)
	require.Equal(t, "rejected", o.item(21).State)
	view, err := o.service.retryItem(ctx, o.repoID, uuidString(item.ID))
	require.NoError(t, err)
	assert.Equal(t, "queued", view.State)
	retried := o.item(21)
	assert.False(t, retried.PRNumber.Valid)
}

// An outsider's approved item never changes a protected path; a maintainer's
// item may. main's factory projection adds its own entries.
func TestMythicalOutsiderItemsNeverChangeProtectedPaths(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	submit := func(number int64, files map[string]string) db.MythicalItem {
		t.Helper()
		stack := o.wake()
		item := o.item(number)
		require.Equal(t, "running", item.State, item.Reason)
		o.project(o.launcher.last("coding/request"), jobs.StateCompleted, fmt.Sprintf("run-%d", number), validatedRequest)
		o.wake()
		require.Equal(t, "delivering", o.item(number).State)
		candidate := o.laneResult(item.WorkspaceID, stack.TipCommit, files, "✨ feat: change")
		_, err := o.service.SubmitLane(ctx, o.repoID, o.userID, MythicalLaneSubmission{WorkspaceID: item.WorkspaceID, Base: stack.TipCommit,
			Source: candidate, RequestRunID: fmt.Sprintf("run-%d", number), Summary: "✨ feat: change"})
		require.NoError(t, err)
		o.wake()
		return o.item(number)
	}

	outsider := mythicalIssue{Number: 31, Title: "Outsider", Body: "fix ci", State: "open", Labels: []string{"todo"}}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, outsider, maintainerTodo))
	require.True(t, o.item(31).Outsider)
	item := submit(31, map[string]string{"src/fix.ts": "fix\n", ".github/workflows/extra.yml": "on: push\n"})
	require.Equal(t, "blocked", item.State)
	assert.Equal(t, "a maintainer changes protected paths: .github/workflows/extra.yml", item.Reason)
	assert.Equal(t, &mythicalFault{Class: "policy", Tag: "protected_paths", Kind: "stopped"}, mythicalChecksOf(item).Fault, "only a person lifts it")
	_, err := o.service.retryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(item.ID))
	requireRunCredentialRefused(t, err)
	assert.Empty(t, o.git(o.github.dir, "branch", "--list", "smithers/todo-31"), "nothing is pushed")

	maintainer := mythicalIssue{Number: 32, Title: "Maintainer", Body: "fix ci", State: "open", TextByMaintainer: true, Labels: []string{"todo"}}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, maintainer, maintainerTodo))
	require.False(t, o.item(32).Outsider)
	item = submit(32, map[string]string{".github/workflows/ci.yml": "on: push\n"})
	require.Equal(t, "proposing", item.State, item.Reason)
}

func TestMythicalProtectedPathsFollowMainsProjection(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	root := t.TempDir()
	f := &gitFixture{t: t, root: root, work: filepath.Join(root, "work")}
	f.git(root, "init", "-q", "--initial-branch=main", f.work)
	require.NoError(t, os.MkdirAll(filepath.Join(f.work, ".smithers"), 0o700))
	require.NoError(t, os.MkdirAll(filepath.Join(f.work, "infra", "keys"), 0o700))
	f.commit("✨ feat: one", "a.txt", "a\n")
	f.commit("🔧 chore: factory", factoryProjectionPath, `{"github":{"mirror":"pull","issues":"two-way","changes":"send-upstream","protectedPaths":["infra/keys"]}}`)
	f.commit("✨ feat: rename", "infra/keys/prod.pem", "k\n")
	head := f.git(f.work, "rev-parse", "HEAD")
	f.git(f.work, "mv", "infra/keys/prod.pem", "moved.pem")
	f.git(f.work, "commit", "-qm", "♻️ refactor: move")
	moved := f.git(f.work, "rev-parse", "HEAD")
	g := mythicalGit{dir: filepath.Join(f.work, ".git")}
	entries, err := g.protectedPaths(context.Background(), moved)
	require.NoError(t, err)
	assert.Contains(t, entries, "infra/keys")
	changed, err := g.changedPaths(context.Background(), head, moved)
	require.NoError(t, err)
	assert.Equal(t, []string{"infra/keys/prod.pem"}, protectedPathsTouched(changed, entries), "a move names its protected origin")
	first := f.git(f.work, "rev-list", "--max-parents=0", "HEAD")
	entries, err = g.protectedPaths(context.Background(), first)
	require.NoError(t, err)
	assert.Equal(t, protectedPathRoots, entries)
}

// mythicalRunContext authenticates as userID through an agent run's
// credential.
func mythicalRunContext(ctx context.Context, userID int64) context.Context {
	return middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{
		User: &db.User{ID: userID}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: "write:repository",
	})
}

func requireRunCredentialRefused(t *testing.T, err error) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, http.StatusForbidden, apiErr.Status, apiErr.Message)
}

// An issue GitHub cannot answer for waits for the next sweep and holds up no
// other issue: an outsider's issue whose label was removed loses its
// approval in the same sweep.
// Nil infrastructure is deliberate: refusal must precede repository, DB,
// GitHub and launcher access, even when a verified candidate is ready.
func TestForeignPushUnavailableProvidersFailClosed(t *testing.T) {
	for _, state := range []string{"queued", "starting", "running", "proposed", "blocked", "waiting"} {
		t.Run(state, func(t *testing.T) {
			checks := mythicalChecks{ForeignHead: "a3", Fault: &mythicalFault{}}
			item := db.MythicalItem{State: state, PRHead: "h0", CandidateHead: "candidate", CandidateVerified: true,
				PendingOp: []byte(`{"branch":"smithers/retry-webhooks","expected":"a3","head":"candidate"}`), Checks: checks.encode()}
			st := &mythicalItemStep{now: time.Unix(100, 0)}
			next, err := st.propose(context.Background(), item)
			require.NoError(t, err)
			require.NotNil(t, next)
			assert.Equal(t, mythicalPublicationUnavailable, next.Reason)
			assert.Equal(t, item.State, next.State)
			assert.Equal(t, item.Checks, next.Checks)
			assert.Equal(t, item.PendingOp, next.PendingOp)
			assert.Equal(t, "h0", next.PRHead)
			assert.Equal(t, "candidate", next.CandidateHead)
			err = st.pushProposal(context.Background(), item, mythicalGitHubRepo{}, mythicalProposalOp{Branch: "smithers/retry-webhooks", Expected: "a3", Head: "candidate"})
			require.EqualError(t, err, mythicalPublicationUnavailable)
		})
	}
}

func TestForeignPushPollCannotSettleHold(t *testing.T) {
	for _, mergeability := range []string{"clean", "dirty", "behind"} {
		t.Run(mergeability, func(t *testing.T) {
			gh := &fakeMythicalGitHub{dir: t.TempDir(), pulls: map[int64]*mythicalPull{
				4: {State: "open", HeadSHA: "h0", HeadRef: "smithers/retry-webhooks", MergeableState: mergeability},
			}}
			st := &mythicalItemStep{s: &MythicalService{github: gh}, r: &mythicalRun{row: db.MythicalStack{
				ActorUserID: pgtype.Int8{Int64: 1, Valid: true}, TipCommit: "new-tip"}}, gh: &mythicalGitHubRepo{}, now: time.Unix(100, 0)}
			item := db.MythicalItem{State: "proposed", PRNumber: pgtype.Int8{Int64: 4, Valid: true},
				PRHead: "h0", Reason: "person decides", Checks: (mythicalChecks{ForeignHead: "a3", Fault: &mythicalFault{}}).encode()}
			next, err := st.follow(context.Background(), item)
			require.NoError(t, err)
			assert.Equal(t, "a3", mythicalChecksOf(*next).ForeignHead)
			assert.Equal(t, "person decides", next.Reason)
			assert.Equal(t, "proposed", next.State)
			gh.pulls[4].HeadSHA = "a4"
			next, err = st.follow(context.Background(), *next)
			require.NoError(t, err)
			assert.Equal(t, "a4", mythicalChecksOf(*next).ForeignHead)
			assert.NotNil(t, mythicalChecksOf(*next).Fault)
			assert.Equal(t, "proposed", next.State)
		})
	}
}

func TestForeignPushPollRetainsTerminalCandidateWhenPrefixMoves(t *testing.T) {
	for _, state := range []string{"dropped", "rejected", "cancelled", "declined", "landed", "merged"} {
		t.Run(state, func(t *testing.T) {
			gh := &fakeMythicalGitHub{dir: t.TempDir(), pulls: map[int64]*mythicalPull{4: {
				State: "open", HeadSHA: "recorded", HeadRef: "smithers/retry-webhooks",
			}}}
			st := &mythicalItemStep{s: &MythicalService{github: gh}, r: &mythicalRun{row: db.MythicalStack{
				ActorUserID: pgtype.Int8{Int64: 1, Valid: true}, TipCommit: "new-prefix"}}, gh: &mythicalGitHubRepo{}, now: time.Unix(100, 0)}
			checks := mythicalChecks{Branch: "smithers/retry-webhooks", Fault: &mythicalFault{},
				Waits: []TodoWait{{ID: "question", Kind: "question", Prompt: "Keep the question"}}}
			item := db.MythicalItem{State: state, PRNumber: pgtype.Int8{Int64: 4, Valid: true}, PRState: "open", PRHead: "recorded",
				CandidateBase: "old-prefix", CandidateHead: "candidate", CandidateVerified: true,
				Checks: checks.encode(), Reason: "retained reason", PendingOp: json.RawMessage(`{`),
				PausedAt: pgtype.Timestamptz{Time: time.Unix(10, 0), Valid: true}}
			next, err := st.follow(context.Background(), item)
			require.NoError(t, err)
			require.NotNil(t, next)
			want := item
			want.NextAttemptAt = pgtype.Timestamptz{Time: time.Unix(100, 0).Add(st.s.pullPollEvery()), Valid: true}
			require.Equal(t, want, *next, "terminal polls may schedule another read, but cannot rebuild the candidate or clear its facts")
		})
	}
}

func TestForeignPushPollUsesPendingIntentAndTerminalDecision(t *testing.T) {
	const branch = "smithers/retry-webhooks"
	for _, tc := range []struct {
		name, state, pending, recordedBranch, fetchedBranch string
		foreign, unavailable                                bool
	}{
		{"intended", "running", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"intended"}`, branch, branch, false, false},
		{"unknown", "proposed", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"unknown"}`, branch, branch, false, false},
		{"done awaiting settlement", "blocked", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"done"}`, branch, branch, false, false},
		{"legacy", "queued", `{"branch":"smithers/retry-webhooks","expected":"old","head":"own"}`, branch, branch, false, false},
		{"conflicting intent", "proposed", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"conflict"}`, branch, branch, true, false},
		{"another operation", "proposed", `{"kind":"open","target":"smithers/retry-webhooks","desired":"own","state":"unknown"}`, branch, branch, true, false},
		{"another intended branch", "proposed", `{"kind":"push","target":"smithers/other","desired":"own","state":"unknown"}`, branch, branch, true, false},
		{"another fetched branch", "proposed", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"unknown"}`, branch, "smithers/other", false, true},
		{"unbound historical branch", "proposed", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"unknown"}`, "", branch, false, true},
		{"malformed intent", "proposed", `{`, branch, branch, false, true},
		{"unknown intent state", "proposed", `{"kind":"push","target":"smithers/retry-webhooks","desired":"own","state":"unexpected"}`, branch, branch, false, true},
		{"dropped", "dropped", `{`, branch, branch, false, false},
		{"rejected", "rejected", `{`, branch, branch, false, false},
		{"cancelled", "cancelled", `{`, branch, branch, false, false},
		{"declined", "declined", `{`, branch, branch, false, false},
		{"landed", "landed", `{`, branch, branch, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gh := &fakeMythicalGitHub{dir: t.TempDir(), pulls: map[int64]*mythicalPull{4: {
				State: "open", HeadSHA: "own", HeadRef: tc.fetchedBranch,
			}}}
			st := &mythicalItemStep{s: &MythicalService{github: gh}, r: &mythicalRun{row: db.MythicalStack{
				ActorUserID: pgtype.Int8{Int64: 1, Valid: true}, TipCommit: "prefix"}}, gh: &mythicalGitHubRepo{}, now: time.Unix(100, 0)}
			checks := mythicalChecks{Branch: tc.recordedBranch, ForeignHead: "earlier-foreign", Fault: &mythicalFault{},
				Waits: []TodoWait{{ID: "question", Kind: "question", Prompt: "Keep the question"}}}
			item := db.MythicalItem{State: tc.state, PRNumber: pgtype.Int8{Int64: 4, Valid: true}, PRState: "open", PRHead: "old",
				CandidateBase: "prefix", CandidateHead: "candidate", CandidateVerified: true,
				PendingOp: json.RawMessage(tc.pending), Checks: checks.encode(), Reason: "earlier hold",
				PausedAt: pgtype.Timestamptz{Time: time.Unix(10, 0), Valid: true}}
			next, err := st.follow(context.Background(), item)
			if tc.unavailable {
				require.ErrorContains(t, err, "read pending GitHub push")
				require.Nil(t, next)
				return
			}
			require.NoError(t, err)
			require.Equal(t, item.State, next.State)
			require.Equal(t, item.PendingOp, next.PendingOp, "polling cannot acknowledge an outbound intent")
			require.Equal(t, item.PRHead, next.PRHead)
			require.Equal(t, item.CandidateHead, next.CandidateHead)
			require.Equal(t, item.CandidateVerified, next.CandidateVerified)
			require.Equal(t, item.PausedAt, next.PausedAt)
			after := mythicalChecksOf(*next)
			require.Equal(t, checks.Waits, after.Waits)
			require.NotNil(t, after.Fault)
			if tc.foreign {
				require.Equal(t, "own", after.ForeignHead)
				require.NotNil(t, after.Notice)
			} else {
				require.Equal(t, "earlier-foreign", after.ForeignHead, "matching own push and terminal facts cannot settle an earlier hold")
				require.Nil(t, after.Notice)
				require.Equal(t, item.Reason, next.Reason)
			}
		})
	}
}

// Enters the production admission boundary with no store, host, launcher or
// lane service: touching any of them before refusal would panic. This is dark
// admission evidence only, not provider integration or the fresh-install gate.
func TestTodoDarkAdmission(t *testing.T) {
	now := time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC)
	for _, state := range []string{"queued", "retrying"} {
		t.Run(state, func(t *testing.T) {
			item := db.MythicalItem{Source: "issue", State: state, Attempt: 2, Generation: 3,
				WorkspaceID: "retained-workspace", RequestRunID: "retained-run",
				CandidateHead: "retained-candidate", Checks: json.RawMessage(`{"launches":4,"outages":1,"replans":2}`)}
			step := mythicalItemStep{now: now}
			refused, admitted, err := step.start(context.Background(), item)
			require.NoError(t, err)
			require.False(t, admitted)
			require.NotNil(t, refused)
			require.Contains(t, refused.Reason, "TODO admission unavailable")
			require.Equal(t, now.Add(time.Minute), refused.NextAttemptAt.Time)
			refused.Reason, refused.NextAttemptAt = item.Reason, item.NextAttemptAt
			require.Equal(t, item, *refused, "dark admission preserves the attempt, counters and old receipts")
		})
	}
}

// No proposal is a failed attempt, never a planner-owned terminal settlement.
// Nil dependencies prove that this boundary neither closes a PR nor launches.
func TestMythicalDeclineFailsWithoutSettlement(t *testing.T) {
	for _, source := range []string{"issue", "chat"} {
		t.Run(source, func(t *testing.T) {
			item := db.MythicalItem{Source: source, State: "running", RequestOutcome: "declined: Already done.",
				RequestRunID: "retained-run", CandidateHead: strings.Repeat("a", 40), Attempt: 2,
				PRNumber: pgtype.Int8{Int64: 9, Valid: true}, PRState: "open",
				Checks: mythicalChecks{Launches: 7, LaunchBase: 3, Replans: 2}.encode()}
			step := &mythicalItemStep{}
			next, saved, err := step.advance(context.Background(), item)
			require.NoError(t, err)
			require.False(t, saved)
			require.NotNil(t, next)
			require.Equal(t, "blocked", next.State)
			require.Equal(t, "Already done.", next.Reason)
			require.Equal(t, item.RequestRunID, next.RequestRunID)
			require.Equal(t, item.CandidateHead, next.CandidateHead)
			require.Equal(t, item.Attempt, next.Attempt)
			require.Equal(t, item.PRNumber, next.PRNumber)
			require.Equal(t, "open", next.PRState)
			checks := mythicalChecksOf(*next)
			require.Equal(t, &mythicalFault{Class: "factory", Tag: "no_proposal", Kind: "plan"}, checks.Fault)
			require.EqualValues(t, 7, checks.Launches)
			require.EqualValues(t, 3, checks.LaunchBase)
			require.EqualValues(t, 2, checks.Replans)
			unchanged, saved, err := step.advance(context.Background(), *next)
			require.NoError(t, err)
			require.False(t, saved)
			require.Nil(t, unchanged, "failed work stays blocked until Retry")
		})
	}
}

func TestMythicalRetryChatItemRetainsIdentityAndCAS(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	item, inserted, err := o.service.queries().InsertMythicalChatItem(ctx, db.MythicalItem{
		RepositoryID: o.repoID, IssueTitle: "Chat change", CandidateHead: strings.Repeat("a", 40), RequestRunID: "retained-run"})
	require.NoError(t, err)
	require.True(t, inserted)
	read := func() db.MythicalItem {
		t.Helper()
		current, err := o.service.queries().GetMythicalItem(ctx, item.ID)
		require.NoError(t, err)
		return current
	}
	item.State = "blocked"
	item.Checks = mythicalChecks{Launches: 7, Replans: 2, Fault: &mythicalFault{Class: "factory", Tag: "no_proposal", Kind: "plan"}}.encode()
	saved, err := o.service.queries().SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	_, err = o.service.retryItem(mythicalRunContext(ctx, o.userID), o.repoID, uuidString(item.ID))
	requireRunCredentialRefused(t, err)
	require.Equal(t, saved.Version, read().Version, "refusal does not advance CAS")
	view, err := o.service.retryItem(ctx, o.repoID, uuidString(item.ID))
	require.NoError(t, err)
	require.Equal(t, "queued", view.State)
	retried := read()
	require.Equal(t, saved.Version+1, retried.Version)
	require.Equal(t, saved.ID, retried.ID)
	require.Equal(t, "chat", retried.Source)
	require.Equal(t, "retained-run", retried.RequestRunID)
	checks := mythicalChecksOf(retried)
	require.EqualValues(t, 7, checks.Launches)
	require.EqualValues(t, 7, checks.LaunchBase)
	require.Zero(t, checks.Replans)
	require.Nil(t, checks.Fault)
}

// Removing fresh request admission must keep the chat-repair refusal without
// reading a lane or resetting persisted engine-phase receipts.
func TestTodoDarkAdmissionChatRepair(t *testing.T) {
	item := db.MythicalItem{Source: "chat", State: "retrying", Attempt: 2, Generation: 3,
		WorkspaceID: "retained-workspace", RequestRunID: "retained-request", VibeRunID: "retained-delivery",
		VerifyRunID: "retained-verify", CandidateHead: "retained-candidate",
		Checks: json.RawMessage(`{"launches":4,"outages":1,"replans":2}`)}
	step := mythicalItemStep{}
	refused, admitted, err := step.start(context.Background(), item)
	require.NoError(t, err)
	require.False(t, admitted)
	require.NotNil(t, refused)
	require.Equal(t, "blocked", refused.State)
	require.Equal(t, "a chat result that no longer applies to the tip must be requested again", refused.Reason)
	refused.State, refused.Reason = item.State, item.Reason
	require.Equal(t, item, *refused)
}
