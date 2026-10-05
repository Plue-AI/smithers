package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var errWorkspaceRepositoryPreparationRefused = errors.New("workspace repository preparation refused")

// A completed setup command or immutable runtime contract can prove that the
// user command did not start. Transport, database and lease errors stay plain.
type workspaceRepositoryPreparationFailure struct{ err error }

func (e *workspaceRepositoryPreparationFailure) Error() string { return e.err.Error() }
func (e *workspaceRepositoryPreparationFailure) Unwrap() error { return e.err }
func (e *workspaceRepositoryPreparationFailure) Is(target error) bool {
	return target == errWorkspaceRepositoryPreparationRefused
}

const (
	workspaceRepositoryReceiptVersion = 1
	workspaceRepositoryReceiptPath    = ".git/smithers-workspace-initialization.json"
	// emptyWorkspaceSourceRevision pins a workspace initialized from a
	// repository that had no refs at all: there is no source commit to verify.
	emptyWorkspaceSourceRevision = "0000000000000000000000000000000000000000"
)

// workspaceRepositoryReceipt is durable workspace-local evidence that the
// common product provisioner initialized this exact repository. It lives in
// Git's private metadata so it persists with the working copy without making
// the repository dirty. SourceRevision pins the remote bookmark observed at
// initialization; later user edits deliberately do not rewrite it.
type workspaceRepositoryReceipt struct {
	Version        int    `json:"version"`
	WorkspaceID    string `json:"workspace_id"`
	RepositoryID   int64  `json:"repository_id"`
	CloneURL       string `json:"clone_url"`
	SourceBookmark string `json:"source_bookmark"`
	SourceRevision string `json:"source_revision"`
	// SourceCommit is the pushed-ref commit the working copy started from
	// (#1968); empty for a bookmark workspace.
	SourceCommit  string    `json:"source_commit,omitempty"`
	InitializedAt time.Time `json:"initialized_at"`
}

func (s *WorkspaceService) ensureRuntimeWorkspaceRepository(ctx context.Context, row db.Workspace, requesterID int64) error {
	return s.ensureRuntimeWorkspaceRepositoryWithReceipt(ctx, row, requesterID, false)
}

// adoptRuntimeWorkspaceRepository is used only after an authorized runtime
// snapshot/fork creates a new product workspace from existing repository
// files. The repository identity and pin must still match; only the copied
// workspace ID in the receipt may be rebound.
func (s *WorkspaceService) adoptRuntimeWorkspaceRepository(ctx context.Context, row db.Workspace, requesterID int64) error {
	return s.ensureRuntimeWorkspaceRepositoryWithReceipt(ctx, row, requesterID, true)
}

func (s *WorkspaceService) ensureRuntimeWorkspaceRepositoryWithReceipt(ctx context.Context, row db.Workspace, requesterID int64, allowReceiptRebind bool) error {
	capabilities := s.runtime.Capabilities()
	if !capabilities.PersistentFiles || !capabilities.Execution || !capabilities.FileOperations {
		return &workspaceRepositoryPreparationFailure{err: pkgerrors.Internal("workspace runtime cannot initialize persistent repositories")}
	}
	if err := s.ensureRuntimeWorkspaceArtifacts(ctx, row, requesterID); err != nil {
		return err
	}
	slug, err := s.workspaceRepoSlug(ctx, row.RepositoryID)
	if err != nil {
		return err
	}
	cloneURL, err := workspaceRepoGitURL(s.gitBaseURL, slug)
	if err != nil {
		return pkgerrors.Internal("build workspace repository url: " + err.Error())
	}
	bookmark := targetWorkspaceBookmark(row.TargetBookmark)

	rootEntries, err := s.listRuntimeRepositoryFiles(ctx, row, requesterID, "inspect-root", "")
	if err != nil {
		return runtimeOperationError("inspect workspace repository root", err)
	}
	root := make(map[string]workspaceapi.FileEntry, len(rootEntries))
	for _, entry := range rootEntries {
		root[entry.Name] = entry
	}
	gitEntry, hasGit := root[".git"]
	if hasGit && !gitEntry.IsDir {
		return pkgerrors.Conflict("workspace repository metadata is not a directory")
	}

	if hasGit {
		gitEntries, listErr := s.listRuntimeRepositoryFiles(ctx, row, requesterID, "inspect-receipt", ".git")
		if listErr != nil {
			return runtimeOperationError("inspect workspace repository receipt", listErr)
		}
		for _, entry := range gitEntries {
			if entry.Name != path.Base(workspaceRepositoryReceiptPath) {
				continue
			}
			if entry.IsDir {
				return pkgerrors.Conflict("workspace repository receipt is not a file")
			}
			contents, readErr := s.readRuntimeRepositoryFile(ctx, row, requesterID, "read-receipt", workspaceRepositoryReceiptPath)
			if readErr != nil {
				return runtimeOperationError("read workspace repository receipt", readErr)
			}
			var receipt workspaceRepositoryReceipt
			if decodeErr := json.Unmarshal(contents, &receipt); decodeErr != nil {
				return pkgerrors.Conflict("workspace repository receipt is invalid")
			}
			if validationErr := validateWorkspaceRepositoryReceiptSource(receipt, row, cloneURL, bookmark); validationErr != nil {
				return validationErr
			}
			jjEntry, hasJJ := root[".jj"]
			if !hasJJ || !jjEntry.IsDir {
				return pkgerrors.Conflict("workspace repository receipt has no Jujutsu working copy")
			}
			if receipt.WorkspaceID != row.ID && !allowReceiptRebind {
				return pkgerrors.Conflict("workspace repository receipt does not match its product workspace")
			}
			if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
				return err
			}
			if err := s.verifyRuntimeRepositorySourcePin(ctx, row, requesterID, receipt.SourceRevision); err != nil {
				return err
			}
			if receipt.WorkspaceID == row.ID {
				return nil
			}
			receipt.WorkspaceID = row.ID
			return s.writeRuntimeRepositoryReceipt(ctx, row, requesterID, receipt)
		}
	}

	// A nonempty root without Git metadata may contain user data or an
	// interrupted setup owned by another tool. Never erase it or clone over it.
	if !hasGit && len(rootEntries) != 0 {
		return pkgerrors.Conflict("workspace root is nonempty and has no repository metadata")
	}

	// The clone reads as the person the machine works for: a branch machine's
	// owner is the install's machine service, which reads no repository.
	reader := row.UserID
	if requesterID > 0 {
		reader = requesterID
	}
	token, err := issueTemporaryRepoCloneToken(ctx, s.q, reader, "workspace-runtime-clone")
	if err != nil {
		return pkgerrors.Internal("create workspace repository token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, reader, token.ID)
	authEnvironment := map[string]string{
		"GIT_CONFIG_COUNT":   "1",
		"GIT_CONFIG_KEY_0":   "http.extraHeader",
		"GIT_CONFIG_VALUE_0": "Authorization: Bearer " + token.Plaintext,
	}

	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "validate-bookmark", workspaceapi.Command{
		Args: []string{"git", "check-ref-format", "--branch", bookmark},
	}); err != nil {
		if lostWorker(err) {
			return err
		}
		return pkgerrors.BadRequest("source bookmark is invalid")
	}

	// A repository with no refs at all (created, never pushed) has no bookmark
	// to clone. Only the authenticated advertisement can tell it apart from an
	// interrupted clone of a populated repository, whose local state looks the
	// same; an authentication or transport failure is never a fallback.
	empty, err := s.runtimeRepositorySourceEmpty(ctx, row, requesterID, cloneURL, authEnvironment)
	if err != nil {
		return err
	}

	if !hasGit {
		args := []string{"git", "clone"}
		if !empty {
			if depth := sandbox.ResolveCloneDepth(s.workspaceCloneDepth(ctx, row.RepositoryID)); depth > 0 {
				args = append(args, "--depth", strconv.Itoa(depth))
			}
			args = append(args, "--branch", bookmark)
		}
		args = append(args, "--", cloneURL, ".")
		if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "clone", workspaceapi.Command{Args: args, Environment: authEnvironment}); err != nil {
			if empty || lostWorker(err) {
				return err
			}
			// git writes origin metadata before transferring objects. Continue the
			// same working copy once so an interrupted clone is repaired without
			// deleting or recloning it.
			if continuationErr := s.continueRuntimeRepositoryCheckout(ctx, row, requesterID, cloneURL, bookmark, authEnvironment); continuationErr != nil {
				if lostWorker(continuationErr) {
					return continuationErr
				}
				return errors.Join(err, continuationErr)
			}
		}
	} else {
		if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
			return err
		}
	}
	if empty {
		// Refs pushed between the advertisement and the clone make this an
		// ordinary checkout of the requested bookmark, which fails closed when
		// the bookmark is missing.
		if empty, err = s.runtimeRepositoryCloneEmpty(ctx, row, requesterID); err != nil {
			return err
		}
		if !empty {
			if err := s.continueRuntimeRepositoryCheckout(ctx, row, requesterID, cloneURL, bookmark, authEnvironment); err != nil {
				return err
			}
		}
	}

	rootEntries, err = s.listRuntimeRepositoryFiles(ctx, row, requesterID, "inspect-jj", "")
	if err != nil {
		return runtimeOperationError("inspect initialized workspace repository", err)
	}
	hasJJ := false
	for _, entry := range rootEntries {
		if entry.Name == ".jj" {
			if !entry.IsDir {
				return pkgerrors.Conflict("workspace Jujutsu metadata is not a directory")
			}
			hasJJ = true
			break
		}
	}
	if empty {
		// Refuse any unreceipted local history rather than resetting user work.
		if err := s.verifyRuntimeEmptyGitRepository(ctx, row, requesterID, hasJJ); err != nil {
			return err
		}
	}
	if !hasJJ && empty {
		if err := s.initializeEmptyRuntimeRepository(ctx, row, requesterID, bookmark); err != nil {
			return err
		}
	} else if !hasJJ {
		if err := s.ensureRuntimeGitHead(ctx, row, requesterID, cloneURL, bookmark, authEnvironment); err != nil {
			return err
		}
		if err := s.fetchRuntimeWorkspaceSource(ctx, row, requesterID, authEnvironment); err != nil {
			return err
		}
		if err := s.initializeRuntimeJujutsu(ctx, row, requesterID, bookmark); err != nil {
			return err
		}
	}

	if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
		return err
	}
	revision := emptyWorkspaceSourceRevision
	if !empty {
		if revision, err = s.runtimeRepositoryRevision(ctx, row, requesterID, bookmark); err != nil {
			return err
		}
	}
	// An isolated runtime finishes its prepared environment offline against
	// the checkout (for example linking dependencies from a prepared store)
	// before the receipt makes the workspace usable.
	if linker, ok := s.runtime.(workspaceapi.WorkspaceEnvironmentLinker); ok {
		linkCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, "link-environment")
		if err != nil {
			return err
		}
		if err := linker.LinkWorkspaceEnvironment(linkCtx, row.ID); err != nil {
			return runtimeOperationError("prepare workspace environment", err)
		}
	}
	receipt := workspaceRepositoryReceipt{
		Version: workspaceRepositoryReceiptVersion, WorkspaceID: row.ID, RepositoryID: row.RepositoryID,
		CloneURL: cloneURL, SourceBookmark: bookmark, SourceRevision: revision, SourceCommit: row.SourceCommit,
		InitializedAt: time.Now().UTC(),
	}
	return s.writeRuntimeRepositoryReceipt(ctx, row, requesterID, receipt)
}

func (s *WorkspaceService) verifyRuntimeEmptyGitRepository(ctx context.Context, row db.Workspace, requesterID int64, hasJJ bool) error {
	allowedObjects := map[string]string{}
	workingCommit := ""
	if hasJJ {
		// An interrupted JJ init leaves its single empty working commit and
		// internal keep ref before the receipt. Recognize exactly that state;
		// never snapshot files, reset history, or accept arbitrary local objects.
		checks := []struct{ step, revision, template, expected string }{
			{"empty-jj-parent", "@-", "commit_id", emptyWorkspaceSourceRevision},
			{"empty-jj-history", "all() ~ root() ~ @", "commit_id", ""},
			{"empty-jj-description", "@", "description", ""},
		}
		for _, check := range checks {
			value, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, check.step, workspaceapi.Command{
				Args: []string{"jj", "log", "--ignore-working-copy", "--no-graph", "-r", check.revision, "-T", check.template},
			})
			if err != nil {
				return err
			}
			if value != check.expected {
				return pkgerrors.Conflict("workspace repository has unreceipted Jujutsu history")
			}
		}
		changes, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "empty-jj-changes", workspaceapi.Command{
			Args: []string{"jj", "diff", "--ignore-working-copy", "--from", "root()", "--to", "@", "--summary"},
		})
		if err != nil {
			return err
		}
		if changes != "" {
			return pkgerrors.Conflict("workspace repository has unreceipted Jujutsu work")
		}
		workingCommit, err = s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "empty-jj-working-commit", workspaceapi.Command{
			Args: []string{"jj", "log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id"},
		})
		if err != nil {
			return err
		}
		if !isLowerHexRevision(workingCommit) || workingCommit == emptyWorkspaceSourceRevision {
			return pkgerrors.Conflict("workspace empty repository working commit is invalid")
		}
		tree, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "empty-jj-tree", workspaceapi.Command{
			Args: []string{"git", "rev-parse", "--verify", workingCommit + "^{tree}"},
		})
		if err != nil {
			return err
		}
		if !isLowerHexRevision(tree) {
			return pkgerrors.Conflict("workspace empty repository working tree is invalid")
		}
		allowedObjects[workingCommit], allowedObjects[tree] = "commit", "tree"
	}
	refs, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "empty-local-refs", workspaceapi.Command{
		Args: []string{"git", "for-each-ref", "--format=%(refname) %(objectname)"},
	})
	if err != nil {
		return err
	}
	for _, line := range strings.Split(refs, "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if !hasJJ || len(fields) != 2 || fields[0] != "refs/jj/keep/"+workingCommit || fields[1] != workingCommit {
			return pkgerrors.Conflict("workspace repository gained refs or has unreceipted local history")
		}
	}
	objects, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "empty-local-objects", workspaceapi.Command{
		Args: []string{"git", "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"},
	})
	if err != nil {
		return err
	}
	seen := make(map[string]bool)
	for _, line := range strings.Split(objects, "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || allowedObjects[fields[0]] != fields[1] {
			return pkgerrors.Conflict("workspace repository has unreceipted local objects")
		}
		seen[fields[0]] = true
	}
	for object := range allowedObjects {
		if !seen[object] {
			return pkgerrors.Conflict("workspace empty repository object is unavailable")
		}
	}
	return nil
}

func (s *WorkspaceService) writeRuntimeRepositoryReceipt(ctx context.Context, row db.Workspace, requesterID int64, receipt workspaceRepositoryReceipt) error {
	contents, err := json.Marshal(receipt)
	if err != nil {
		return pkgerrors.Internal("encode workspace repository receipt: " + err.Error())
	}
	contents = append(contents, '\n')
	operationCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, "write-receipt")
	if err != nil {
		return err
	}
	if err := s.runtime.WriteFile(operationCtx, row.ID, workspaceRepositoryReceiptPath, contents, 0o600); err != nil {
		return runtimeOperationError("commit workspace repository receipt", err)
	}
	return nil
}

func (s *WorkspaceService) runtimeRepositoryContext(ctx context.Context, row db.Workspace, requesterID int64, step string) (context.Context, error) {
	operationCtx, err := s.workspaceRuntimeContext(ctx, row, requesterID, workspaceLifecycleOperation(row, "repository-"+step))
	if err != nil {
		return nil, err
	}
	return operationCtx, nil
}

func (s *WorkspaceService) listRuntimeRepositoryFiles(ctx context.Context, row db.Workspace, requesterID int64, step, filePath string) ([]workspaceapi.FileEntry, error) {
	operationCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, step)
	if err != nil {
		return nil, err
	}
	return s.runtime.ListFiles(operationCtx, row.ID, filePath)
}

func (s *WorkspaceService) readRuntimeRepositoryFile(ctx context.Context, row db.Workspace, requesterID int64, step, filePath string) ([]byte, error) {
	operationCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, step)
	if err != nil {
		return nil, err
	}
	return s.runtime.ReadFile(operationCtx, row.ID, filePath)
}

func (s *WorkspaceService) executeRuntimeRepositoryTransfer(ctx context.Context, row db.Workspace, requesterID int64, step string, command workspaceapi.Command) (workspaceapi.CommandResult, error) {
	// Git transfers safely retry an admission
	// refusal. Give each completed failed attempt its own durable operation ID;
	// otherwise the adapter would replay that failure instead of fetching again.
	execCtx, cancel := context.WithTimeout(ctx, workspaceCloneTimeout)
	defer cancel()
	var result workspaceapi.CommandResult
	for attempt := 0; ; attempt++ {
		attemptStep := step
		if attempt > 0 {
			attemptStep += "-retry-" + strconv.Itoa(attempt)
		}
		operationCtx, err := s.runtimeRepositoryContext(execCtx, row, requesterID, attemptStep)
		if err != nil {
			return result, err
		}
		if err := operationCtx.Err(); err != nil {
			return result, err
		}
		result, err = s.runtime.ExecuteCommand(operationCtx, row.ID, command)
		if err != nil {
			return result, runtimeOperationError("initialize workspace repository ("+step+")", err)
		}
		if attempt >= 3 || !retryableWorkspaceTransfer(command, result) {
			break
		}
		if command.Args[1] == "clone" {
			// Git removes its new metadata after a refused clone. Retry
			// only when it left the destination empty; never erase partial
			// repositories or user files to make a retry possible.
			entries, err := s.listRuntimeRepositoryFiles(execCtx, row, requesterID, attemptStep+"-retry-inspect", "")
			if err != nil {
				return result, runtimeOperationError("inspect refused workspace clone", err)
			}
			if len(entries) != 0 {
				break
			}
		}
		timer := time.NewTimer(time.Second << attempt)
		select {
		case <-execCtx.Done():
			timer.Stop()
			return result, execCtx.Err()
		case <-timer.C:
		}
	}
	return result, nil
}

func (s *WorkspaceService) runRuntimeRepositoryCommand(ctx context.Context, row db.Workspace, requesterID int64, step string, command workspaceapi.Command) error {
	result, err := s.executeRuntimeRepositoryTransfer(ctx, row, requesterID, step, command)
	if err != nil {
		return err
	}
	if result.ExitCode == 0 && !result.OutputTruncated {
		return nil
	}
	detail := strings.TrimSpace(result.Stderr)
	if out := strings.TrimSpace(result.Stdout); out != "" {
		if detail != "" {
			detail += "\n"
		}
		detail += out
	}
	if len(detail) > 1000 {
		detail = detail[len(detail)-1000:]
	}
	if result.OutputTruncated {
		detail = strings.TrimSpace(detail + "\ncommand output was truncated")
	}
	return &workspaceRepositoryPreparationFailure{err: pkgerrors.Internal(fmt.Sprintf("initialize workspace repository (%s) failed with status %d: %s", step, result.ExitCode, detail))}
}

// Git reports an HTTP refusal in stderr. Do not retry authentication errors,
// truncated evidence, transport uncertainty, or commands that change checkout.
func retryableWorkspaceTransfer(command workspaceapi.Command, result workspaceapi.CommandResult) bool {
	if len(command.Args) < 2 || command.Args[0] != "git" || (command.Args[1] != "fetch" && command.Args[1] != "clone" && command.Args[1] != "ls-remote") || result.ExitCode == 0 || result.OutputTruncated {
		return false
	}
	return strings.Contains(result.Stderr, "The requested URL returned error: 503") || strings.Contains(result.Stderr, "The requested URL returned error: 504")
}

func (s *WorkspaceService) runtimeRepositoryCommandOutput(ctx context.Context, row db.Workspace, requesterID int64, step string, command workspaceapi.Command) (string, error) {
	result, err := s.executeRuntimeRepositoryTransfer(ctx, row, requesterID, step, command)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 || result.OutputTruncated {
		return "", pkgerrors.Conflict("workspace repository " + step + " could not be verified")
	}
	return strings.TrimSpace(result.Stdout), nil
}

func (s *WorkspaceService) verifyRuntimeRepositoryOrigin(ctx context.Context, row db.Workspace, requesterID int64, expected string) error {
	actual, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "origin", workspaceapi.Command{Args: []string{"git", "remote", "get-url", "origin"}})
	if err != nil {
		return err
	}
	if !sameWorkspaceRepositoryURL(actual, expected) {
		return pkgerrors.Conflict("workspace repository origin does not match its product repository")
	}
	return nil
}

func sameWorkspaceRepositoryURL(actual, expected string) bool {
	canonical := func(raw string) string {
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return ""
		}
		parsed.User = nil
		parsed.Fragment = ""
		parsed.Path = path.Clean(parsed.Path)
		return parsed.String()
	}
	return canonical(actual) != "" && canonical(actual) == canonical(expected)
}

func (s *WorkspaceService) continueRuntimeRepositoryCheckout(ctx context.Context, row db.Workspace, requesterID int64, cloneURL, bookmark string, environment map[string]string) error {
	if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
		return err
	}
	args := []string{"git", "fetch"}
	if depth := workspaceSourceFetchDepth(s.workspaceCloneDepth(ctx, row.RepositoryID)); depth != "" {
		args = append(args, depth)
	}
	args = append(args, "origin", bookmark)
	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "fetch", workspaceapi.Command{
		Args: args, Environment: environment,
	}); err != nil {
		return err
	}
	return s.runRuntimeRepositoryCommand(ctx, row, requesterID, "checkout", workspaceapi.Command{
		Args: []string{"git", "checkout", "-B", bookmark, "origin/" + bookmark},
	})
}

func (s *WorkspaceService) ensureRuntimeGitHead(ctx context.Context, row db.Workspace, requesterID int64, cloneURL, bookmark string, environment map[string]string) error {
	if _, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "head", workspaceapi.Command{Args: []string{"git", "rev-parse", "--verify", "HEAD^{commit}"}}); err == nil {
		return nil
	}
	return s.continueRuntimeRepositoryCheckout(ctx, row, requesterID, cloneURL, bookmark, environment)
}

// runtimeRepositorySourceEmpty asks the product remote, with the workspace's
// own credential, whether the repository advertises any ref at all.
func (s *WorkspaceService) runtimeRepositorySourceEmpty(ctx context.Context, row db.Workspace, requesterID int64, cloneURL string, environment map[string]string) (bool, error) {
	refs, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "advertisement", workspaceapi.Command{
		Args: []string{"git", "ls-remote", "--", cloneURL}, Environment: environment,
	})
	if err != nil {
		return false, err
	}
	return refs == "", nil
}

// runtimeRepositoryCloneEmpty reports whether the clone received no refs.
func (s *WorkspaceService) runtimeRepositoryCloneEmpty(ctx context.Context, row db.Workspace, requesterID int64) (bool, error) {
	refs, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "clone-refs", workspaceapi.Command{
		Args: []string{"git", "for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin/"},
	})
	if err != nil {
		return false, err
	}
	return refs == "", nil
}

// initializeEmptyRuntimeRepository names the unborn branch after the source
// bookmark and colocates Jujutsu. Nothing pretends the remote bookmark exists.
func (s *WorkspaceService) initializeEmptyRuntimeRepository(ctx context.Context, row db.Workspace, requesterID int64, bookmark string) error {
	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "unborn-head", workspaceapi.Command{
		Args: []string{"git", "symbolic-ref", "HEAD", "refs/heads/" + bookmark},
	}); err != nil {
		return err
	}
	return s.runRuntimeRepositoryCommand(ctx, row, requesterID, "jj-init", workspaceapi.Command{
		Args: []string{"jj", "git", "init", "--colocate", "."},
	})
}

// verifyRuntimeRepositorySourcePin checks that the pinned source commit is
// still present. A workspace initialized from an empty repository has none.
func (s *WorkspaceService) verifyRuntimeRepositorySourcePin(ctx context.Context, row db.Workspace, requesterID int64, revision string) error {
	if revision == emptyWorkspaceSourceRevision {
		return nil
	}
	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "verify-source-pin", workspaceapi.Command{
		Args: []string{"git", "cat-file", "-e", revision + "^{commit}"},
	}); err != nil {
		if lostWorker(err) {
			return err
		}
		return pkgerrors.Conflict("workspace repository source pin is unavailable")
	}
	return nil
}

func (s *WorkspaceService) initializeRuntimeJujutsu(ctx context.Context, row db.Workspace, requesterID int64, bookmark string) error {
	commands := []struct {
		step string
		args []string
		soft bool
	}{
		{step: "jj-init", args: []string{"jj", "git", "init", "--colocate", "."}},
		{step: "jj-track", args: []string{"jj", "bookmark", "track", bookmark + "@origin"}, soft: true},
		{step: "jj-bookmark", args: []string{"jj", "bookmark", "set", bookmark, "-r", bookmark + "@origin"}},
		{step: "jj-working-copy", args: []string{"jj", "new", workspaceSourceCheckout(row, bookmark)}},
	}
	for _, command := range commands {
		if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, command.step, workspaceapi.Command{Args: command.args}); err != nil && !command.soft {
			return err
		}
	}
	return nil
}

func (s *WorkspaceService) runtimeRepositoryRevision(ctx context.Context, row db.Workspace, requesterID int64, bookmark string) (string, error) {
	revision, err := s.runtimeRepositoryCommandOutput(ctx, row, requesterID, "source-revision", workspaceapi.Command{
		Args: []string{"git", "rev-parse", "--verify", "refs/remotes/origin/" + bookmark + "^{commit}"},
	})
	if err != nil {
		return "", err
	}
	if !isLowerHexRevision(revision) {
		return "", pkgerrors.Conflict("workspace repository source revision is invalid")
	}
	return revision, nil
}

func isLowerHexRevision(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func validateWorkspaceRepositoryReceiptSource(receipt workspaceRepositoryReceipt, row db.Workspace, cloneURL, bookmark string) error {
	if receipt.Version != workspaceRepositoryReceiptVersion || receipt.RepositoryID != row.RepositoryID || receipt.SourceBookmark != bookmark ||
		!sameWorkspaceRepositoryURL(receipt.CloneURL, cloneURL) || !isLowerHexRevision(receipt.SourceRevision) ||
		receipt.InitializedAt.IsZero() {
		return pkgerrors.Conflict("workspace repository receipt does not match its product repository")
	}
	// A pushed-ref workspace never adopts a working copy started elsewhere.
	if row.SourceCommit != "" && receipt.SourceCommit != row.SourceCommit {
		return pkgerrors.Conflict("workspace repository receipt does not match its pushed ref")
	}
	return nil
}
