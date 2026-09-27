package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// The mythical stack service is the only writer of a repository's
// refs/heads/mythical: one linear history of logical changes whose tree
// always equals the last folded main commit. It never writes main.
//
// One worker claim per repository (the github_main_pulls pattern: requested
// and processed generations, a lease, claim fencing, execution bounded inside
// the lease). Each write is prepared deterministically, persisted as
// pending_op, pushed in one atomic receive-pack with exact old values through
// a loopback bridge that accepts only that command set, confirmed on the
// repository's jj bookmark, and only then finalized.

const (
	mythicalLease         = 10 * time.Minute
	mythicalLeaseMargin   = time.Minute
	mythicalMinimumRun    = 30 * time.Second
	mythicalPollInterval  = 3 * time.Second
	mythicalSweepInterval = 5 * time.Minute
	mythicalClaimLimit    = 8
	mythicalFoldLimit     = 500
	mythicalChainLimit    = 5000
	mythicalBootstrapMax  = 500
	mythicalRecentChanges = 200
)

// MythicalStore is the database the service writes through: queries plus
// transactions for the finalize step.
type MythicalStore interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// mythicalRepoHost is repo-host's surface the stack writes through: the git
// transport, bookmark reads, and the jj import of git refs.
type mythicalRepoHost interface {
	gitHubMainPullRepoHost
	ImportRefs(ctx context.Context, owner, repo string) error
}

type MythicalService struct {
	store       MythicalStore
	host        mythicalRepoHost
	scratchRoot string
	logger      *slog.Logger
	now         func() time.Time

	// The item machinery (SetOrchestration); absent, the stack only
	// bootstraps and folds.
	github    mythicalGitHub
	launcher  mythicalLauncher
	lanes     mythicalLanes
	wikiStore mythicalWikiStore
	mu        sync.Mutex
	backfills map[int64]time.Time
}

func NewMythicalService(store MythicalStore, host mythicalRepoHost) *MythicalService {
	return &MythicalService{store: store, host: host, scratchRoot: filepath.Join(os.TempDir(), "smithers-mythical"),
		logger: slog.Default(), now: time.Now}
}

func (s *MythicalService) queries() *db.Queries { return db.New(s.store) }

// RequestBootstrap asks the worker to create the repository's stack, or with
// reset to rebuild it from main. It returns at once; the worker does the work.
func (s *MythicalService) RequestBootstrap(ctx context.Context, repositoryID, actorUserID int64, depth int32, reset bool) (db.MythicalStack, error) {
	if depth <= 0 {
		depth = 100
	}
	if depth > mythicalBootstrapMax {
		depth = mythicalBootstrapMax
	}
	row, err := s.queries().RequestMythicalBootstrap(ctx, repositoryID, actorUserID, depth, reset)
	if err == nil {
		s.notify(ctx, s.queries(), repositoryID, row.Generation, "stack", "")
	}
	return row, err
}

// MainMoved asks an existing stack to fold main. It is a no-op for a
// repository without a stack.
func (s *MythicalService) MainMoved(ctx context.Context, repositoryID int64) {
	if s == nil {
		return
	}
	if _, err := s.queries().RequestMythicalStack(ctx, repositoryID); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.request_failed", "repository_id", repositoryID, "error", err)
	}
}

func (s *MythicalService) notify(ctx context.Context, q *db.Queries, repositoryID, generation int64, kind, itemID string) {
	payload, _ := json.Marshal(map[string]any{"generation": generation, "kind": kind, "itemId": itemID, "event_id": strconv.FormatInt(generation, 10)})
	if err := q.NotifyMythical(ctx, repositoryID, string(payload)); err != nil && ctx.Err() == nil {
		s.logger.Warn("mythical.notify_failed", "repository_id", repositoryID, "error", err)
	}
}

// Start runs the worker until ctx ends.
func (s *MythicalService) Start(ctx context.Context) {
	lastSweep := time.Time{}
	for {
		if s.now().Sub(lastSweep) >= mythicalSweepInterval {
			if _, err := s.queries().RequestStaleMythicalStacks(ctx, mythicalSweepInterval.Seconds()); err != nil && ctx.Err() == nil {
				s.logger.Error("mythical.sweep_failed", "error", err)
			}
			lastSweep = s.now()
		}
		if err := s.PollOnce(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("mythical.claim_failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(mythicalPollInterval):
		}
	}
}

// PollOnce claims and runs due stacks one at a time.
func (s *MythicalService) PollOnce(ctx context.Context) error {
	for range mythicalClaimLimit {
		if ctx.Err() != nil {
			return nil
		}
		rows, err := s.queries().ClaimMythicalStacks(ctx, 1, mythicalLease.Seconds())
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		s.runClaimed(ctx, rows[0])
	}
	return nil
}

// mythicalOp is a prepared stack write. It is persisted before the push
// with every input needed to compute it again, so a restarted worker can tell
// whether the push happened and, when it did not, push exactly the same
// objects instead of different work.
type mythicalOp struct {
	Kind       string              `json:"kind"`
	OldTip     string              `json:"oldTip"`
	NewTip     string              `json:"newTip"`
	NewChange  string              `json:"newChange"`
	OldNotes   string              `json:"oldNotes"`
	NewNotes   string              `json:"newNotes"`
	LandedMain string              `json:"landedMain"`
	From       int32               `json:"from"`
	Changes    []db.MythicalChange `json:"changes"`
	// Replay inputs: bootstrap reads Main at Depth; fold copies Folded (main
	// commits, oldest first) onto OldTip.
	Main            string   `json:"main,omitempty"`
	Depth           int      `json:"depth,omitempty"`
	Folded          []string `json:"folded,omitempty"`
	ResetGeneration int64    `json:"resetGeneration,omitempty"`
	// Adopt names, per folded main commit, the merged item whose candidate
	// the fold adopts when its tree is exactly that commit's tree.
	Adopt map[string]mythicalAdoption `json:"adopt,omitempty"`
}

// mythicalAdoption is a merged item's verified candidate.
type mythicalAdoption struct {
	ItemID string `json:"itemId"`
	Issue  int64  `json:"issue,omitempty"`
	Base   string `json:"base"`
	Head   string `json:"head"`
}

// mythicalOutcome is what one run records.
type mythicalOutcome struct {
	state, reason, err string
	failed             bool
	heldFor            time.Duration // the repository was held: try again then
	clearPending       bool          // the prepared write is settled or discarded
	op                 *mythicalOp   // a confirmed write to finalize
}

func (s *MythicalService) runClaimed(parent context.Context, row db.MythicalStack) {
	deadline := s.now().Add(mythicalLease - mythicalLeaseMargin)
	if row.LeaseExpiresAt.Valid {
		if leaseEnd := row.LeaseExpiresAt.Time.Add(-mythicalLeaseMargin); leaseEnd.Before(deadline) {
			deadline = leaseEnd
		}
	}
	if !deadline.After(s.now().Add(mythicalMinimumRun)) {
		s.logger.Warn("mythical.claim_expired", "repository_id", row.RepositoryID, "claim", row.Claim)
		return
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()
	var outcome mythicalOutcome
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				outcome = mythicalOutcome{failed: true, err: "internal error"}
				s.logger.Error("mythical.panic", "repository_id", row.RepositoryID, "panic", recovered)
			}
		}()
		outcome = s.run(ctx, row)
	}()
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer finishCancel()
	if err := s.finish(finishCtx, row, outcome); err != nil {
		s.logger.Error("mythical.finish_failed", "repository_id", row.RepositoryID, "error", err)
	} else if outcome.op != nil {
		// Items advance on the next claim, against the new tip.
		s.MainMoved(finishCtx, row.RepositoryID)
	}
	attrs := []any{"repository_id", row.RepositoryID, "state", outcome.state}
	if outcome.op != nil {
		attrs = append(attrs, "kind", outcome.op.Kind, "tip", outcome.op.NewTip, "landed_main", outcome.op.LandedMain)
	}
	if outcome.heldFor > 0 {
		s.logger.Info("mythical.held", append(attrs, "retry_in", outcome.heldFor.String())...)
	} else if outcome.failed {
		s.logger.Warn("mythical.failed", append(attrs, "attempts", row.Attempts, "error", outcome.err)...)
	} else {
		s.logger.Info("mythical.run", attrs...)
	}
}

func (s *MythicalService) finish(ctx context.Context, row db.MythicalStack, outcome mythicalOutcome) error {
	tx, err := s.store.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	q := db.New(tx)
	params := db.FinishMythicalStackParams{RepositoryID: row.RepositoryID, Claim: row.Claim, State: outcome.state,
		Reason: outcome.reason, Failed: outcome.failed, Error: outcome.err, BackoffSeconds: gitHubMainPullBackoff(row.Attempts).Seconds(),
		ClearPendingOp: outcome.clearPending, Changed: outcome.state != "" && outcome.state != row.State}
	if outcome.heldFor > 0 {
		// Still due, after the hold's delay, with no attempt spent and no error.
		params.Failed, params.Held, params.BackoffSeconds = true, true, outcome.heldFor.Seconds()
	}
	if op := outcome.op; op != nil {
		if err := q.ReplaceMythicalChanges(ctx, row.RepositoryID, op.From, op.Changes); err != nil {
			return err
		}
		params.TipCommit, params.TipChange, params.NotesCommit, params.LandedMain = op.NewTip, op.NewChange, op.NewNotes, op.LandedMain
		params.Changed, params.ClearPendingOp, params.ResetGeneration = true, true, op.ResetGeneration
	}
	generation, err := q.FinishMythicalStack(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		s.logger.Warn("mythical.claim_lost", "repository_id", row.RepositoryID, "claim", row.Claim)
		return nil
	}
	if err != nil {
		return err
	}
	// A failed pass changes nothing but lastError; the hint still lets a watcher show it.
	if params.Changed || (params.Failed && !params.Held) {
		s.notify(ctx, q, row.RepositoryID, generation, "stack", "")
	}
	return tx.Commit(ctx)
}

func mythicalFrozen(format string, args ...any) mythicalOutcome {
	return mythicalOutcome{state: "frozen", reason: fmt.Sprintf(format, args...)}
}

func mythicalFailed(format string, args ...any) mythicalOutcome {
	return mythicalOutcome{failed: true, err: fmt.Sprintf(format, args...)}
}

// mythicalHeldMaxDelay bounds how long a stack write waits on a held
// repository before it is tried again.
const mythicalHeldMaxDelay = time.Minute

// mythicalHeld is a pass whose write the repository's host refused while
// holding the repository: nothing failed, and the same work is due again
// after delay (bounded), without spending an attempt.
func mythicalHeld(delay time.Duration) mythicalOutcome {
	return mythicalOutcome{heldFor: min(max(delay, time.Second), mythicalHeldMaxDelay)}
}

// mythicalRun is one claim's view of the repository.
type mythicalRun struct {
	row                    db.MythicalStack
	g                      mythicalGit
	bridge                 *mythicalBridge
	owner, repo, branch    string
	mainTip, tip, notesRef string
}

// run decides and performs at most one stack write.
func (s *MythicalService) run(ctx context.Context, row db.MythicalStack) mythicalOutcome {
	q := s.queries()
	repository, err := q.GetRepoByID(ctx, row.RepositoryID)
	if err != nil {
		return mythicalFailed("load repository: %v", err)
	}
	owner, err := mythicalRepositoryOwner(ctx, q, repository)
	if err != nil {
		return mythicalFailed("%v", err)
	}
	branch := strings.TrimSpace(repository.DefaultBookmark)
	if branch == "" {
		branch = "main"
	}
	g := mythicalGit{dir: filepath.Join(s.scratchRoot, "repo-"+strconv.FormatInt(row.RepositoryID, 10)+".git")}
	if err := os.MkdirAll(s.scratchRoot, 0o700); err != nil {
		return mythicalFailed("create scratch directory: %v", err)
	}
	if err := g.init(ctx); err != nil {
		return mythicalFailed("%v", err)
	}
	bridge, err := startMythicalBridge(ctx, s.host, owner, repository.Name)
	if err != nil {
		return mythicalFailed("%v", err)
	}
	defer bridge.Close()
	remote := bridge.URL()
	refs, err := g.lsRemote(ctx, remote)
	if err != nil {
		return mythicalFailed("read repository refs: %v", sanitizeMirrorError(err, remote))
	}
	r := &mythicalRun{row: row, g: g, bridge: bridge, owner: owner, repo: repository.Name, branch: branch,
		mainTip: refs["refs/heads/"+branch], tip: refs[repohost.MythicalBookmarkRef], notesRef: refs[repohost.MythicalNotesRef]}
	if r.mainTip == "" {
		return mythicalFailed("the repository has no %s bookmark", branch)
	}

	// A prepared write from an earlier claim is settled before anything else.
	if len(row.PendingOp) > 0 {
		var op mythicalOp
		if err := json.Unmarshal(row.PendingOp, &op); err != nil {
			return mythicalFrozen("the prepared stack write is unreadable")
		}
		switch {
		case r.tip == op.NewTip && r.notesRef == op.NewNotes:
			return s.confirm(ctx, r, op, true)
		case r.tip == op.OldTip && r.notesRef == op.OldNotes:
			// The push never landed: push exactly the prepared objects again.
			return s.replay(ctx, r, op)
		case row.ResetGeneration > op.ResetGeneration:
			// A newer reset replaces whatever the refs hold; the old write is moot.
		default:
			return mythicalFrozen("the mythical refs moved outside the stack service (bookmark %s, notes %s; expected %s or %s)",
				short(r.tip), short(r.notesRef), short(op.OldTip), short(op.NewTip))
		}
	}

	switch {
	case row.ResetGeneration > 0 || row.State == "bootstrapping":
		return s.bootstrap(ctx, r)
	case row.State == "frozen":
		return mythicalOutcome{state: "frozen", reason: row.Reason}
	}
	if r.tip != row.TipCommit || r.notesRef != row.NotesCommit {
		return mythicalFrozen("the mythical bookmark or its notes moved outside the stack service (bookmark %s, recorded %s)",
			short(r.tip), short(row.TipCommit))
	}
	if r.mainTip == row.LandedMain {
		// The stack is current: this claim moves the items and the wiki instead.
		s.advanceItems(ctx, r)
		s.advanceWiki(ctx, r)
		return mythicalOutcome{state: "active", clearPending: true}
	}
	return s.fold(ctx, r)
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	if id == "" {
		return "(none)"
	}
	return id
}

func mythicalRepositoryOwner(ctx context.Context, q *db.Queries, repository db.Repository) (string, error) {
	switch {
	case repository.UserID.Valid:
		user, err := q.GetUserByID(ctx, repository.UserID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner: %w", err)
		}
		return user.Username, nil
	case repository.OrgID.Valid:
		org, err := q.GetOrgByID(ctx, repository.OrgID.Int64)
		if err != nil {
			return "", fmt.Errorf("load repository owner: %w", err)
		}
		return org.Name, nil
	}
	return "", fmt.Errorf("repository %d has no owner", repository.ID)
}

// lsRemote lists the repository's refs through the bridge.
func (g mythicalGit) lsRemote(ctx context.Context, remote string) (map[string]string, error) {
	out, err := gitHubMainPullCommand(ctx, "ls-remote", remote).CombinedOutput()
	if err != nil {
		return nil, gitHubMainPullCommandError("git ls-remote", err, out)
	}
	refs := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		sha, ref, ok := strings.Cut(line, "\t")
		if ok && mythicalSHA.MatchString(sha) {
			refs[ref] = sha
		}
	}
	return refs, nil
}

// fetch brings refs into the scratch repository under refs/mythical-scratch/.
// A scratch repository left inconsistent by a crash is discarded once.
func (g mythicalGit) fetch(ctx context.Context, remote string, depth, deepen int, refs ...string) error {
	args := []string{"fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance"}
	if depth > 0 {
		args = append(args, "--depth="+strconv.Itoa(depth))
	}
	if deepen > 0 {
		args = append(args, "--deepen="+strconv.Itoa(deepen))
	}
	args = append(args, remote)
	for _, ref := range refs {
		args = append(args, "+"+ref+":refs/mythical-scratch/"+strings.TrimPrefix(ref, "refs/"))
	}
	if _, err := g.git(ctx, args...); err != nil {
		if ctx.Err() != nil {
			return err
		}
		if removeErr := os.RemoveAll(g.dir); removeErr != nil {
			return err
		}
		if initErr := g.init(ctx); initErr != nil {
			return err
		}
		_, err = g.git(ctx, args...)
		return err
	}
	return nil
}

func (g mythicalGit) has(ctx context.Context, commit string) bool {
	_, err := g.git(ctx, "cat-file", "-e", commit+"^{commit}")
	return err == nil
}

// errMythicalDiverged is main proven not to descend from the folded commit:
// the scratch repository holds main's complete history.
var errMythicalDiverged = errors.New("main does not descend from the last folded commit")

// connectMain fetches main until from is on its history. Running out of the
// per-claim budget is a retryable failure: the scratch repository keeps what
// it fetched (later fetches never shorten it) and the next claim continues.
func (s *MythicalService) connectMain(ctx context.Context, r *mythicalRun, from string) error {
	remote := r.bridge.URL()
	depth := 0
	if !r.g.has(ctx, r.mainTip) {
		// Only an empty scratch repository starts shallow; an incremental
		// fetch keeps the boundary it already deepened.
		if _, err := r.g.git(ctx, "rev-parse", "--verify", "--quiet", "refs/mythical-scratch/heads/"+r.branch); err != nil {
			depth = 64
		}
		if err := r.g.fetch(ctx, remote, depth, 0, "refs/heads/"+r.branch); err != nil {
			return fmt.Errorf("fetch %s: %s", r.branch, sanitizeMirrorError(err, remote))
		}
	}
	for round := 0; ; round++ {
		if r.g.has(ctx, from) {
			if ancestor, err := r.g.isAncestor(ctx, from, r.mainTip); err == nil && ancestor {
				return nil
			}
		}
		if !r.g.shallow() {
			if r.g.has(ctx, from) {
				return errMythicalDiverged
			}
			return fmt.Errorf("%s is not in %s's complete history", short(from), r.branch)
		}
		if round == 4 {
			return fmt.Errorf("%s is not yet connected to %s (%s); fetching more history on the next run", short(from), r.branch, short(r.mainTip))
		}
		if err := r.g.fetch(ctx, remote, 0, 512, "refs/heads/"+r.branch); err != nil {
			return fmt.Errorf("deepen %s: %s", r.branch, sanitizeMirrorError(err, remote))
		}
	}
}

// shallow reports whether the scratch repository has a shallow boundary.
func (g mythicalGit) shallow() bool {
	out, err := g.git(context.Background(), "rev-parse", "--is-shallow-repository")
	return err != nil || strings.TrimSpace(out) != "false"
}

// connectWindow fetches main until commit's first-parent window of depth+1
// commits is complete (or reaches the root), so a bootstrap recomputes the
// identical objects however far main has moved since.
func (s *MythicalService) connectWindow(ctx context.Context, r *mythicalRun, commit string, depth int) error {
	remote := r.bridge.URL()
	// Only an empty scratch repository starts shallow; later fetches keep
	// every boundary already deepened, so progress survives across claims.
	initial := 0
	if _, err := r.g.git(ctx, "rev-parse", "--verify", "--quiet", "refs/mythical-scratch/heads/"+r.branch); err != nil {
		initial = depth + 1
	}
	if err := r.g.fetch(ctx, remote, initial, 0, "refs/heads/"+r.branch); err != nil {
		return fmt.Errorf("fetch %s: %s", r.branch, sanitizeMirrorError(err, remote))
	}
	for round := 0; ; round++ {
		if r.g.has(ctx, commit) {
			chain, err := r.g.firstParents(ctx, commit, depth+1)
			if err == nil && (len(chain) == depth+1 || (len(chain) > 0 && chain[len(chain)-1].Parent() == "" && !r.g.isShallowBoundary(chain[len(chain)-1].ID))) {
				return nil
			}
		}
		if !r.g.shallow() || round == 8 {
			return fmt.Errorf("the bootstrap window of %s is not available yet", short(commit))
		}
		if err := r.g.fetch(ctx, remote, 0, 512, "refs/heads/"+r.branch); err != nil {
			return fmt.Errorf("deepen %s: %s", r.branch, sanitizeMirrorError(err, remote))
		}
	}
}

// isShallowBoundary reports whether commit's parents were cut by a shallow fetch.
func (g mythicalGit) isShallowBoundary(commit string) bool {
	data, err := os.ReadFile(filepath.Join(g.dir, "shallow"))
	return err == nil && strings.Contains(string(data), commit)
}

func (s *MythicalService) bootstrap(ctx context.Context, r *mythicalRun) mythicalOutcome {
	op := mythicalOp{Kind: "bootstrap", OldTip: r.tip, OldNotes: r.notesRef, Main: r.mainTip,
		Depth: int(r.row.BootstrapDepth), ResetGeneration: r.row.ResetGeneration}
	if err := s.connectWindow(ctx, r, op.Main, op.Depth); err != nil {
		return mythicalFailed("%v", err)
	}
	if err := s.compute(ctx, r, &op); err != nil {
		return mythicalFailed("%v", err)
	}
	if r.tip != "" && r.tip != op.NewTip && r.row.ResetGeneration == 0 {
		return mythicalFrozen("a mythical bookmark already exists at %s; bootstrap with reset to replace it", short(r.tip))
	}
	return s.apply(ctx, r, op)
}

func (s *MythicalService) fold(ctx context.Context, r *mythicalRun) mythicalOutcome {
	remote := r.bridge.URL()
	if err := r.g.fetch(ctx, remote, 0, 0, repohost.MythicalBookmarkRef, repohost.MythicalNotesRef); err != nil {
		return mythicalFailed("fetch the stack: %v", sanitizeMirrorError(err, remote))
	}
	if err := s.connectMain(ctx, r, r.row.LandedMain); errors.Is(err, errMythicalDiverged) {
		return mythicalFrozen("main (%s) does not descend from the last folded commit %s; it was rewritten", short(r.mainTip), short(r.row.LandedMain))
	} else if err != nil {
		return mythicalFailed("%v", err)
	}
	landed, err := r.g.readCommit(ctx, r.row.LandedMain)
	if err != nil {
		return mythicalFailed("%v", err)
	}
	current, err := r.g.readCommit(ctx, r.row.TipCommit)
	if err != nil {
		return mythicalFailed("%v", err)
	}
	if current.Tree != landed.Tree {
		return mythicalFrozen("the stack tip %s no longer has the folded main's tree", short(r.row.TipCommit))
	}
	commits, onLine, err := r.g.firstParentsSince(ctx, r.row.LandedMain, r.mainTip, mythicalFoldLimit)
	if err != nil {
		return mythicalFailed("%v", err)
	}
	if !onLine {
		return mythicalFrozen("the folded commit %s is not on %s's first-parent line", short(r.row.LandedMain), r.branch)
	}
	if len(commits) == 0 {
		return mythicalOutcome{state: "active", clearPending: true}
	}
	existing, err := s.queries().ListMythicalChanges(ctx, r.row.RepositoryID)
	if err != nil {
		return mythicalFailed("load the stack: %v", err)
	}
	op := mythicalOp{Kind: "fold", OldTip: r.row.TipCommit, OldNotes: r.row.NotesCommit, From: int32(len(existing))}
	for _, commit := range commits {
		op.Folded = append(op.Folded, commit.ID)
	}
	if err := s.adoptions(ctx, r, &op); err != nil {
		return mythicalFailed("%v", err)
	}
	if err := s.compute(ctx, r, &op); err != nil {
		return mythicalFailed("%v", err)
	}
	return s.apply(ctx, r, op)
}

// compute fills op's results from its inputs. It is deterministic, so a
// replay after a crash recomputes the identical objects.
func (s *MythicalService) compute(ctx context.Context, r *mythicalRun, op *mythicalOp) error {
	var written []mythicalStackCommit
	notesByCommit := map[string]string{}
	var kept map[string]bool // commits of the unchanged prefix, for pruning notes
	switch op.Kind {
	case "bootstrap":
		commits, err := r.g.bootstrap(ctx, op.Main, op.Depth)
		if err != nil {
			return fmt.Errorf("build the stack: %w", err)
		}
		written, op.From, op.LandedMain = commits, 0, op.Main
	case "fold":
		notes, err := r.g.readNotes(ctx, op.OldNotes)
		if err != nil {
			return fmt.Errorf("read notes: %w", err)
		}
		notesByCommit = notes
		rows, err := s.queries().ListMythicalChanges(ctx, r.row.RepositoryID)
		if err != nil {
			return fmt.Errorf("load the stack: %w", err)
		}
		position := make(map[string]int32, len(rows))
		for _, row := range rows {
			position[row.CommitID] = row.Position
		}
		from, parent := op.From, op.OldTip
		for _, id := range op.Folded {
			m, err := r.g.readCommit(ctx, id)
			if err != nil {
				return err
			}
			if adoption, ok := op.Adopt[id]; ok {
				adopted, ok, err := r.g.adopt(ctx, parent, mythicalCandidate{ItemID: adoption.ItemID, Issue: adoption.Issue,
					Base: adoption.Base, Head: adoption.Head}, mythicalChainLimit)
				if err != nil {
					return fmt.Errorf("adopt %s: %w", short(adoption.Head), err)
				}
				if ok && len(adopted) > 0 && adopted[len(adopted)-1].Tree == m.Tree {
					// The candidate's changes land where its plan put them: the
					// stack is cut at the candidate's fork.
					first, err := r.g.readCommit(ctx, adopted[0].ID)
					if err != nil {
						return err
					}
					fork := first.Parent()
					cut := -1
					for i, commit := range written {
						if commit.ID == fork {
							cut = i
						}
					}
					switch {
					case cut >= 0:
						written = written[:cut+1]
					case fork == "":
						from, written = 0, nil
					default:
						p, ok := position[fork]
						if !ok {
							return fmt.Errorf("the candidate forks from %s, which is not on the stack", short(fork))
						}
						from, written = p+1, nil
					}
					adopted[len(adopted)-1].FoldedFrom = id
					written, parent = append(written, adopted...), adopted[len(adopted)-1].ID
					continue
				}
			}
			step, err := r.g.flatFold(ctx, parent, m, "fold")
			if err != nil {
				return fmt.Errorf("fold %s: %w", short(id), err)
			}
			written, parent = append(written, step), step.ID
		}
		op.From, op.LandedMain = from, op.Folded[len(op.Folded)-1]
		kept = map[string]bool{}
		for _, row := range rows {
			if row.Position < from {
				kept[row.CommitID] = true
			}
		}
	default:
		return fmt.Errorf("unknown stack write %q", op.Kind)
	}
	op.Changes = make([]db.MythicalChange, len(written))
	if kept != nil {
		// Notes of rewritten commits go with them.
		for commit := range notesByCommit {
			if !kept[commit] {
				delete(notesByCommit, commit)
			}
		}
	}
	for i, commit := range written {
		op.Changes[i] = mythicalChangeRow(r.row.RepositoryID, op.From+int32(i), commit)
		notesByCommit[commit.ID] = mythicalNote(commit)
	}
	newNotes, err := r.g.writeNotes(ctx, notesByCommit, mythicalNotesStamp)
	if err != nil {
		return fmt.Errorf("write notes: %w", err)
	}
	last := written[len(written)-1]
	op.NewTip, op.NewChange, op.NewNotes = last.ID, last.ChangeID, newNotes
	return nil
}

// replay pushes a prepared write that never landed, after recomputing it
// from its recorded inputs and requiring the identical result.
func (s *MythicalService) replay(ctx context.Context, r *mythicalRun, op mythicalOp) mythicalOutcome {
	remote := r.bridge.URL()
	again := mythicalOp{Kind: op.Kind, OldTip: op.OldTip, OldNotes: op.OldNotes, From: op.From, Main: op.Main, Depth: op.Depth,
		Folded: op.Folded, ResetGeneration: op.ResetGeneration, Adopt: op.Adopt}
	switch op.Kind {
	case "bootstrap":
		// The recorded main may be far behind the current one: fetch its own
		// window, never recompute from a shorter history.
		if err := s.connectWindow(ctx, r, op.Main, op.Depth); err != nil {
			return mythicalFailed("%v", err)
		}
	case "fold":
		if err := r.g.fetch(ctx, remote, 0, 0, repohost.MythicalBookmarkRef, repohost.MythicalNotesRef); err != nil {
			return mythicalFailed("fetch the stack: %v", sanitizeMirrorError(err, remote))
		}
		if len(op.Folded) == 0 {
			return mythicalFrozen("the prepared fold is empty")
		}
		if err := s.connectMain(ctx, r, op.Folded[0]); err != nil && !errors.Is(err, errMythicalDiverged) {
			return mythicalFailed("%v", err)
		}
		for _, adoption := range op.Adopt {
			if !r.g.has(ctx, adoption.Head) {
				if err := r.g.fetch(ctx, remote, 0, 0, repohost.MythicalReservedRefNS+"keep/"+adoption.Head); err != nil {
					return mythicalFailed("fetch the adopted candidate: %v", sanitizeMirrorError(err, remote))
				}
			}
		}
	}
	if err := s.compute(ctx, r, &again); err != nil {
		return mythicalFailed("%v", err)
	}
	if again.NewTip != op.NewTip || again.NewNotes != op.NewNotes {
		return mythicalFrozen("the prepared %s write could not be reproduced (%s, expected %s)", op.Kind, short(again.NewTip), short(op.NewTip))
	}
	return s.push(ctx, r, op)
}

func mythicalChangeRow(repositoryID int64, position int32, commit mythicalStackCommit) db.MythicalChange {
	row := db.MythicalChange{RepositoryID: repositoryID, Position: position, ChangeID: commit.ChangeID, CommitID: commit.ID,
		Title: commit.Title, Kind: commit.Kind, Predecessor: commit.Predecessor, FoldedFrom: commit.FoldedFrom}
	if commit.Issue > 0 {
		row.IssueNumber = pgtype.Int8{Int64: commit.Issue, Valid: true}
	}
	if commit.ItemID != "" {
		_ = row.ItemID.Scan(commit.ItemID)
	}
	return row
}

// apply persists op and pushes it.
func (s *MythicalService) apply(ctx context.Context, r *mythicalRun, op mythicalOp) mythicalOutcome {
	encoded, err := json.Marshal(op)
	if err != nil {
		return mythicalFailed("encode the prepared write: %v", err)
	}
	written, err := s.queries().SetMythicalPendingOp(ctx, r.row.RepositoryID, r.row.Claim, encoded)
	if err != nil {
		return mythicalFailed("record the prepared write: %v", err)
	}
	if written == 0 {
		return mythicalFailed("the stack claim was lost before the write")
	}
	return s.push(ctx, r, op)
}

// push sends op's refs in one atomic receive-pack with exact old values.
func (s *MythicalService) push(ctx context.Context, r *mythicalRun, op mythicalOp) mythicalOutcome {
	zero := strings.Repeat("0", 40)
	orZero := func(id string) string {
		if id == "" {
			return zero
		}
		return id
	}
	r.bridge.permit([]mythicalRefUpdate{
		{Ref: repohost.MythicalBookmarkRef, Old: orZero(op.OldTip), New: op.NewTip},
		{Ref: repohost.MythicalNotesRef, Old: orZero(op.OldNotes), New: op.NewNotes},
	}, repohost.ReceivePackMetadata{ControlPlane: true, PusherLogin: "smithers"})
	remote := r.bridge.URL()
	if _, err := r.g.git(ctx, "push", "--atomic", "--porcelain", "--no-verify", remote,
		"+"+op.NewTip+":"+repohost.MythicalBookmarkRef, "+"+op.NewNotes+":"+repohost.MythicalNotesRef); err != nil {
		if delay, held := r.bridge.held(); held {
			return mythicalHeld(delay)
		}
		// Whether it landed is settled from the refs on the next claim.
		return mythicalFailed("push the stack: %s", sanitizeMirrorError(err, remote))
	}
	return s.confirm(ctx, r, op, false)
}

// confirm finalizes op once the repository's jj bookmark shows the new tip.
// Recovering a push whose jj import may have been lost asks the repository
// to import its git refs first.
func (s *MythicalService) confirm(ctx context.Context, r *mythicalRun, op mythicalOp, recovering bool) mythicalOutcome {
	target, err := s.bookmarkCommit(ctx, r.owner, r.repo, MythicalBookmark)
	if err == nil && target != op.NewTip && recovering {
		if importErr := s.host.ImportRefs(ctx, r.owner, r.repo); importErr != nil {
			if delay, held := repohost.HeldRetryAfter(importErr); held {
				return mythicalHeld(delay)
			}
			return mythicalFailed("import the stack into the repository: %v", importErr)
		}
		target, err = s.bookmarkCommit(ctx, r.owner, r.repo, MythicalBookmark)
	}
	if err != nil {
		return mythicalFailed("confirm the stack: %v", err)
	}
	if target != op.NewTip {
		return mythicalFailed("the repository has not imported the new stack tip yet")
	}
	confirmed := op
	return mythicalOutcome{state: "active", op: &confirmed}
}

func (s *MythicalService) bookmarkCommit(ctx context.Context, owner, repo, name string) (string, error) {
	const pageSize, maxPages = 100, 100
	cursor := ""
	for range maxPages {
		bookmarks, next, err := s.host.ListBookmarks(ctx, owner, repo, cursor, pageSize)
		if err != nil {
			return "", err
		}
		for _, bookmark := range bookmarks {
			if bookmark.Name == name {
				return strings.TrimSpace(bookmark.TargetCommitID), nil
			}
		}
		if next == "" || next == cursor || len(bookmarks) == 0 {
			return "", nil
		}
		cursor = next
	}
	return "", fmt.Errorf("bookmark listing exceeded %d pages", maxPages)
}

// MainHead reads a bookmark's commit for the snapshot's behind flag.
func (s *MythicalService) MainHead(ctx context.Context, owner, repo, bookmark string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return s.bookmarkCommit(ctx, owner, repo, bookmark)
}

// readNotes returns the notes of a notes commit, keyed by annotated commit.
func (g mythicalGit) readNotes(ctx context.Context, notesCommit string) (map[string]string, error) {
	notes := map[string]string{}
	if notesCommit == "" {
		return notes, nil
	}
	out, err := g.git(ctx, "ls-tree", "-r", notesCommit)
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(out, "\n") {
		meta, path, ok := strings.Cut(line, "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) != 3 || fields[1] != "blob" {
			continue
		}
		id := strings.ReplaceAll(path, "/", "")
		if !mythicalSHA.MatchString(id) {
			continue
		}
		body, err := g.command(ctx, nil, "cat-file", "blob", fields[2])
		if err != nil {
			return nil, err
		}
		notes[id] = string(body)
	}
	return notes, nil
}

// mythicalNotesStamp dates every notes commit identically, so a notes
// commit is a pure function of its notes.
const mythicalNotesStamp = "0 +0000"

// adoptions names the merged items whose PR merge commits this fold copies,
// and fetches their pinned candidates. A merge commit no item claims folds flat.
func (s *MythicalService) adoptions(ctx context.Context, r *mythicalRun, op *mythicalOp) error {
	s.refreshMerged(ctx, r)
	items, err := s.queries().ListMythicalItems(ctx, r.row.RepositoryID, 1000)
	if err != nil {
		return err
	}
	folded := make(map[string]bool, len(op.Folded))
	for _, id := range op.Folded {
		folded[id] = true
	}
	var refs []string
	for _, item := range items {
		if item.PRMergeCommit == "" || !folded[item.PRMergeCommit] || item.CandidateHead == "" || item.CandidateBase == "" {
			continue
		}
		if op.Adopt == nil {
			op.Adopt = map[string]mythicalAdoption{}
		}
		op.Adopt[item.PRMergeCommit] = mythicalAdoption{ItemID: uuidString(item.ID), Issue: item.IssueNumber.Int64,
			Base: item.CandidateBase, Head: item.CandidateHead}
		if !r.g.has(ctx, item.CandidateHead) {
			refs = append(refs, repohost.MythicalReservedRefNS+"keep/"+item.CandidateHead)
		}
	}
	if len(refs) > 0 {
		if err := r.g.fetch(ctx, r.bridge.URL(), 0, 0, refs...); err != nil {
			// A candidate that cannot be fetched folds flat; content stays exact.
			for id, adoption := range op.Adopt {
				if !r.g.has(ctx, adoption.Head) {
					delete(op.Adopt, id)
				}
			}
		}
	}
	return nil
}

// refreshMerged reads the pull requests of proposed items before a fold, so
// a merge the fold copies is attributed to its item (merge evidence, never
// tree equality alone). Failures only mean the fold copies flat.
func (s *MythicalService) refreshMerged(ctx context.Context, r *mythicalRun) {
	if s.github == nil {
		return
	}
	q := s.queries()
	items, err := q.ListMythicalItems(ctx, r.row.RepositoryID, 1000)
	if err != nil {
		return
	}
	step := &mythicalItemStep{s: s, r: r, q: q, now: s.now()}
	for _, item := range items {
		if item.State != "proposed" {
			continue
		}
		next, err := step.follow(ctx, item)
		if err != nil || next == nil || next.State == item.State {
			continue
		}
		if saved, err := q.SaveMythicalItem(ctx, *next); err == nil {
			s.notify(ctx, q, r.row.RepositoryID, r.row.Generation, "item", uuidString(saved.ID))
		}
	}
}
