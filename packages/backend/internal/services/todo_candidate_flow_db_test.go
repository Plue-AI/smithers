package services

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"github.com/stretchr/testify/require"
)

// PostgreSQL serialization proof for the existing claimed proposal path.
// Packaged guest dispatch and real-microVM acceptance remain separate checks.
func TestCandidatePushRevalidatesUnderOwningClaim(t *testing.T) {
	for _, change := range []string{"none", "version", "verification", "prefix", "main", "claim", "expired", "merge fence", "closed", "attempt", "pending push"} {
		t.Run(change, func(t *testing.T) {
			f := newMythicalServiceFixture(t)
			ctx := t.Context()
			q := db.New(f.pool)
			_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
			require.NoError(t, err)
			main := strings.Repeat("a", 40)
			_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET state='active',running=true,claim=7,landed_main=$2,lease_expires_at=now()+interval '1 minute' WHERE repository_id=$1`, f.repoID, main)
			require.NoError(t, err)
			var earlierID, id pgtype.UUID
			require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','running','Earlier',$2,$3,false) RETURNING id`, f.repoID, main, strings.Repeat("b", 40)).Scan(&earlierID))
			require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','proposing','Candidate',$2,$3,true) RETURNING id`, f.repoID, main, strings.Repeat("c", 40)).Scan(&id))
			row, err := q.GetMythicalStack(ctx, f.repoID)
			require.NoError(t, err)
			item, err := q.GetMythicalItem(ctx, id)
			require.NoError(t, err)
			step := &mythicalItemStep{s: f.service, r: &mythicalRun{row: row, mainTip: main}}
			switch change {
			case "merge fence":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','merge','target','1','desired',$2::text,'state','intended') WHERE id=$1`, id, item.CandidateHead)
			case "closed":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, id)
			case "attempt":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET attempt=attempt+1 WHERE id=$1`, id)
			case "pending push":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET pending_op=jsonb_build_object('kind','push','target','smithers/other','desired',$2::text,'state','intended') WHERE id=$1`, id, item.CandidateHead)
			case "version":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET version=version+1 WHERE id=$1`, id)
			case "verification":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=false WHERE id=$1`, id)
			case "prefix":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET candidate_verified=true WHERE id=$1`, earlierID)
			case "main":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET landed_main=$2 WHERE repository_id=$1`, f.repoID, strings.Repeat("d", 40))
			case "claim":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET claim=claim+1 WHERE repository_id=$1`, f.repoID)
			case "expired":
				_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET lease_expires_at=now()-interval '1 second' WHERE repository_id=$1`, f.repoID)
			}
			require.NoError(t, err)
			pushes := 0
			err = step.pushCurrentProposal(ctx, item, func() error { pushes++; return nil })
			if change == "none" {
				require.NoError(t, err)
				require.Equal(t, 1, pushes)
			} else {
				require.Error(t, err)
				require.Zero(t, pushes)
			}
		})
	}
}

func TestCandidatePushHoldsStackMutationUntilEffectReturns(t *testing.T) {
	f := newMythicalServiceFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	q := db.New(f.pool)
	_, err := q.RequestMythicalBootstrap(ctx, f.repoID, f.userID, 1, false)
	require.NoError(t, err)
	main := strings.Repeat("a", 40)
	_, err = f.pool.Exec(ctx, `UPDATE mythical_stacks SET running=true,claim=1,landed_main=$2,lease_expires_at=now()+interval '1 minute' WHERE repository_id=$1`, f.repoID, main)
	require.NoError(t, err)
	var id pgtype.UUID
	require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,candidate_base,candidate_head,candidate_verified) VALUES($1,'todo','proposing','Candidate',$2,$3,true) RETURNING id`, f.repoID, main, strings.Repeat("c", 40)).Scan(&id))
	row, err := q.GetMythicalStack(ctx, f.repoID)
	require.NoError(t, err)
	item, err := q.GetMythicalItem(ctx, id)
	require.NoError(t, err)
	step := &mythicalItemStep{s: f.service, r: &mythicalRun{row: row, mainTip: main}}
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- step.pushCurrentProposal(ctx, item, func() error {
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-entered:
	case err := <-done:
		t.Fatalf("push did not start: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// NOWAIT independently proves the row is locked through the external effect.
	tx, err := f.pool.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE NOWAIT`, f.repoID)
	require.Error(t, err)
	require.NoError(t, tx.Rollback(ctx))
	close(release)
	require.NoError(t, <-done)
	require.NoError(t, pgx.BeginFunc(ctx, f.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE NOWAIT`, f.repoID)
		return err
	}))
}

// reservedGuest replaces only the microVM boundary: product observations run
// as real JJ and Git commands in a colocated guest checkout.
type reservedGuest struct {
	workspaceapi.WorkspaceRuntime
	dir          string
	calls, stops int
}

func (g *reservedGuest) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}

// The worker offers placement and releases lanes through the same runtime.
func (g *reservedGuest) Capabilities() workspaceapi.WorkspaceCapabilities {
	return workspaceapi.WorkspaceCapabilities{}
}

func (g *reservedGuest) StopWorkspace(context.Context, string) error {
	g.stops++
	return nil
}

// Review lanes are other machines; this fixture provisions none.
var errNoReviewMachine = errors.New("no review machine in this fixture")

func (g *reservedGuest) CreateWorkspace(context.Context, workspaceapi.WorkspaceSpec) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, errNoReviewMachine
}

func (g *reservedGuest) InspectWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, errNoReviewMachine
}

func (g *reservedGuest) StartWorkspace(context.Context, string) (workspaceapi.Workspace, error) {
	return workspaceapi.Workspace{}, errNoReviewMachine
}

func (g *reservedGuest) DeleteWorkspace(context.Context, string) error {
	return errNoReviewMachine
}

// panicLog records the stack worker's recovered panics.
type panicLog struct {
	mu     sync.Mutex
	panics []string
}

func (l *panicLog) Write(line []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if bytes.Contains(line, []byte("mythical.panic")) {
		l.panics = append(l.panics, string(line))
	}
	return len(line), nil
}

func (l *panicLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.panics...)
}

func (g *reservedGuest) ExecuteCommand(ctx context.Context, _ string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	g.calls++
	cmd := exec.CommandContext(ctx, command.Args[0], command.Args[1:]...)
	cmd.Dir = g.dir
	cmd.Env = append(os.Environ(), "PWD="+g.dir)
	for key, value := range command.Environment {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return workspaceapi.CommandResult{ExitCode: exit.ExitCode(), Stdout: stdout.String(), Stderr: stderr.String()}, nil
		}
		return workspaceapi.CommandResult{}, err
	}
	return workspaceapi.CommandResult{Stdout: stdout.String()}, nil
}

func (g *reservedGuest) run(t *testing.T, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = g.dir
	cmd.Env = append(os.Environ(), "PWD="+g.dir, "JJ_USER=Guest", "JJ_EMAIL=guest@example.test", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "%s %v: %s", name, args, out)
	return strings.TrimSpace(string(out))
}

// hostWorkspaceSources acknowledges a source only when the repository host
// actually retains its workspace ref at that commit.
type hostWorkspaceSources struct{ hostDir string }

func (h hostWorkspaceSources) ReadWorkspaceSource(_ context.Context, _, _ string, request repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error) {
	ref := repohost.WorkspaceSourceRef(request.WorkspaceID, request.Source.CommitID)
	out, err := exec.Command("git", "--git-dir", h.hostDir, "rev-parse", "--verify", "--quiet", ref).Output()
	if err != nil || strings.TrimSpace(string(out)) != request.Source.CommitID {
		return repohost.WorkspaceSourceReceipt{}, &repohost.StatusError{StatusCode: 404, Code: "workspace_source_missing"}
	}
	return repohost.WorkspaceSourceReceipt{Status: "retained", WorkspaceID: request.WorkspaceID, Ref: ref, Source: request.Source}, nil
}

// TestReservedCandidateProposesVerifiedTree is the positive packaged-op
// campaign at the host boundary of both reserved operations: real PostgreSQL,
// Git, JJ guest checkout, stack worker and GitHub fake. The microVM and the
// native helper's HTTP hop are the only substitutions.
func TestReservedCandidateProposesVerifiedTree(t *testing.T) {
	f := newRebaseFixture(t)
	ctx := context.Background()
	q := db.New(f.pool)
	item := f.candidate("Reserved positive", f.main, "AGENT.md", "agent work\n")
	guest := &reservedGuest{dir: filepath.Join(t.TempDir(), "guest")}
	f.git(f.root, "clone", "-q", f.hostDir, guest.dir)
	guest.run(t, "jj", "git", "init", "--colocate")
	_, err := f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,vm_id,status) VALUES($1,$2,$3,'reserved','reserved-vm','running')`, item.WorkspaceID, f.repoID, f.userID)
	require.NoError(t, err)
	_, err = f.pool.Exec(ctx, `INSERT INTO mythical_lanes(workspace_id,repository_id,item_id,name) VALUES($1,$2,$3,'request')`, item.WorkspaceID, f.repoID, item.ID)
	require.NoError(t, err)
	// The composed TODO run is attached and has not offered a candidate yet.
	item.State, item.Reason, item.Attempt, item.BaseCommit, item.Generation = "running", "", 1, f.main, 4
	item.CandidateBase, item.CandidateHead, item.CandidateVerified = "", "", false
	item.RequestRunID = "current-run"
	item.FlowDigest = pgtype.Text{String: todoPinOne, Valid: true}
	checks := mythicalChecksOf(item)
	checks.FlowSource, checks.RunAttached = f.main, true
	item.Checks = checks.encode()
	item, err = q.SaveMythicalItem(ctx, item)
	require.NoError(t, err)
	generation := item.Generation

	machine := NewWorkspaceService(q, WithWorkspaceInstallAuthorization(q), WithWorkspaceTransactions(f.pool.(*pgxpool.Pool)), WithWorkspaceRuntime(guest), WithWorkspaceSourceReader(hostWorkspaceSources{hostDir: f.hostDir}))
	f.service.SetOrchestration(f.service.github, f.service.launcher, NewWorkspaceMythicalLanes(machine))
	f.service.installAuthorization = true
	panics := &panicLog{}
	f.service.logger = slog.New(slog.NewTextHandler(panics, nil))
	defer func() { require.Empty(t, panics.all(), "the stack worker never panics") }()
	user, err := q.GetUserByID(ctx, f.userID)
	require.NoError(t, err)
	scopes := strings.Join([]string{"write:repository", middleware.RepositoryRestrictionScope(f.repoID), middleware.WorkspaceRestrictionScope(item.WorkspaceID), middleware.AgentSessionRestrictionScope("current-run")}, ",")
	machineCtx := registerTestInstallCredential(t, f.pool, middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &user, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: scopes, Scopes: middleware.ParseTokenScopes(scopes)}), f.repoID)
	call := func(command string, input ReservedStackInput) (ReservedStackResult, int) {
		t.Helper()
		result, status, err := f.service.ReservedStackOperation(machineCtx, f.repoID, item.WorkspaceID, command, input)
		var api *pkgerrors.APIError
		var access *AccessError
		switch {
		case errors.As(err, &api):
			return result, api.Status
		case errors.As(err, &access):
			return result, access.Status
		}
		require.NoError(t, err)
		return result, status
	}

	// Preflight admits the current run before the guest is observed.
	_, status := call("stack.candidate", ReservedStackInput{RequestID: "11111111-1111-4111-8111-111111111111"})
	require.Equal(t, 204, status)
	require.Zero(t, guest.calls)

	// The guest seals its bytes and retains them on the host, as the native
	// helper does after a 204.
	require.NoError(t, os.WriteFile(filepath.Join(guest.dir, "MEMBER.md"), []byte("member bytes\n"), 0o600))
	guest.run(t, "jj", "commit", "-m", "member work")
	head := guest.run(t, "jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id")
	change := guest.run(t, "jj", "log", "--no-graph", "-r", "@-", "-T", "change_id")
	tree := guest.run(t, "git", "rev-parse", head+"^{tree}")
	guest.run(t, "git", "push", "-q", f.hostDir, head+":"+repohost.WorkspaceSourceRef(item.WorkspaceID, head))
	source := repohost.WorkspaceSource{ChangeID: change, CommitID: head, TreeID: tree, ParentCommitIDs: []string{f.main}}
	capture := ReservedStackInput{RequestID: "11111111-1111-4111-8111-111111111111", Source: &source}

	_, status = call("stack.candidate", capture)
	require.Equal(t, 202, status, "changed bytes wait for the owning claim")
	pending := f.item(item.Number.Int64)
	require.Equal(t, generation, pending.Generation, "admission allocates no generation")
	require.NotNil(t, mythicalChecksOf(pending).Capture)
	require.Zero(t, f.verifies(pending))
	_, status = call("stack.candidate", capture)
	require.Equal(t, 202, status)
	require.Equal(t, pending.Version, f.item(item.Number.Int64).Version, "a replay while pending writes nothing")

	// The owning claim pins the retained bytes, allocates one generation and
	// launches the separate verification.
	f.wake()
	verifying := f.item(item.Number.Int64)
	require.Equal(t, "verifying", verifying.State, verifying.Reason)
	require.Equal(t, generation+1, verifying.Generation)
	require.Equal(t, f.main, verifying.CandidateBase)
	require.Equal(t, head, verifying.CandidateHead)
	require.Nil(t, mythicalChecksOf(verifying).Capture)
	require.Equal(t, 1, f.verifies(verifying))

	result, status := call("stack.candidate", capture)
	require.Equal(t, 200, status)
	require.Equal(t, ReservedStackResult{Generation: generation + 1, Base: f.main, Head: head}, result)
	proposal := ReservedStackInput{RequestID: "22222222-2222-4222-8222-222222222222", Generation: generation + 1}
	_, status = call("stack.propose", proposal)
	require.Equal(t, 202, status, "running checks hold the proposal; they do not refuse it")
	require.Empty(t, f.githubRef(mythicalChecksOf(f.item(item.Number.Int64)).Branch), "nothing is published before verification")

	// The pinned attempt's verification run names its execution identity.
	var launch flowdispatch.LaunchRequest
	for _, request := range f.launcher.all("coding/verify") {
		if strings.HasPrefix(request.RequestID, "mythical:"+uuidString(verifying.ID)+":") {
			launch = request
		}
	}
	require.Contains(t, string(launch.Payload), head)
	output := `{"status":"passed","failed":[],"receipts":[]}`
	require.NoError(t, f.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateCompleted, Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: launch.Projection, FlowID: "coding/verify", ExecutionDigest: todoPinOne, RunID: "verify-reserved", Run: &flowruntime.FlowRuntimeRun{RunID: "verify-reserved", FinalOutput: &output}}}))
	f.wake()
	proposed := f.item(item.Number.Int64)
	require.Equal(t, "proposed", proposed.State, proposed.Reason)
	require.Equal(t, generation+1, proposed.Generation)
	require.Equal(t, 1, f.verifies(proposed), "one verification")
	// Independently observed GitHub bytes: the PR head has the verified
	// candidate's tree on main.
	require.Equal(t, proposed.PRHead, f.githubRef(mythicalChecksOf(proposed).Branch))
	require.Equal(t, tree, f.git(f.github, "rev-parse", proposed.PRHead+"^{tree}"))
	require.Equal(t, f.main, f.git(f.github, "rev-parse", proposed.PRHead+"^"))
	require.Equal(t, "member bytes", f.git(f.github, "show", proposed.PRHead+":MEMBER.md"))
	writes := len(f.writes())
	require.Len(t, f.pullCreates(), 1)
	f.wake()
	require.Len(t, f.writes(), writes, "no second push or pull request")
}
