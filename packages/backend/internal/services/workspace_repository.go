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

const (
	workspaceRepositoryReceiptVersion = 1
	workspaceRepositoryReceiptPath    = ".git/smithers-workspace-initialization.json"
)

// workspaceRepositoryReceipt is durable workspace-local evidence that the
// common product provisioner initialized this exact repository. It lives in
// Git's private metadata so it persists with the working copy without making
// the repository dirty. SourceRevision pins the remote bookmark observed at
// initialization; later user edits deliberately do not rewrite it.
type workspaceRepositoryReceipt struct {
	Version        int       `json:"version"`
	WorkspaceID    string    `json:"workspace_id"`
	RepositoryID   int64     `json:"repository_id"`
	CloneURL       string    `json:"clone_url"`
	SourceBookmark string    `json:"source_bookmark"`
	SourceRevision string    `json:"source_revision"`
	InitializedAt  time.Time `json:"initialized_at"`
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
		return pkgerrors.Internal("workspace runtime cannot initialize persistent repositories")
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
		return pkgerrors.Internal("inspect workspace repository root: " + err.Error())
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
			return pkgerrors.Internal("inspect workspace repository receipt: " + listErr.Error())
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
				return pkgerrors.Internal("read workspace repository receipt: " + readErr.Error())
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
			if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "verify-source-pin", workspaceapi.Command{
				Args: []string{"git", "cat-file", "-e", receipt.SourceRevision + "^{commit}"},
			}); err != nil {
				return pkgerrors.Conflict("workspace repository source pin is unavailable")
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

	token, err := issueTemporaryRepoCloneToken(ctx, s.q, row.UserID, "workspace-runtime-clone")
	if err != nil {
		return pkgerrors.Internal("create workspace repository token: " + err.Error())
	}
	defer revokeTemporaryRepoCloneToken(ctx, s.q, row.UserID, token.ID)
	authEnvironment := map[string]string{
		"GIT_CONFIG_COUNT":   "1",
		"GIT_CONFIG_KEY_0":   "http.extraHeader",
		"GIT_CONFIG_VALUE_0": "Authorization: Bearer " + token.Plaintext,
	}

	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "validate-bookmark", workspaceapi.Command{
		Args: []string{"git", "check-ref-format", "--branch", bookmark},
	}); err != nil {
		return pkgerrors.BadRequest("source bookmark is invalid")
	}

	if !hasGit {
		args := []string{"git", "clone"}
		if depth := sandbox.ResolveCloneDepth(s.workspaceCloneDepth(ctx, row.RepositoryID)); depth > 0 {
			args = append(args, "--depth", strconv.Itoa(depth))
		}
		args = append(args, "--branch", bookmark, "--", cloneURL, ".")
		if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "clone", workspaceapi.Command{Args: args, Environment: authEnvironment}); err != nil {
			// git writes origin metadata before transferring objects. Continue the
			// same working copy once so an interrupted clone is repaired without
			// deleting or recloning it.
			if continuationErr := s.continueRuntimeRepositoryCheckout(ctx, row, requesterID, cloneURL, bookmark, authEnvironment); continuationErr != nil {
				return errors.Join(err, continuationErr)
			}
		}
	} else {
		if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
			return err
		}
	}

	rootEntries, err = s.listRuntimeRepositoryFiles(ctx, row, requesterID, "inspect-jj", "")
	if err != nil {
		return pkgerrors.Internal("inspect initialized workspace repository: " + err.Error())
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
	if !hasJJ {
		if err := s.ensureRuntimeGitHead(ctx, row, requesterID, cloneURL, bookmark, authEnvironment); err != nil {
			return err
		}
		if err := s.initializeRuntimeJujutsu(ctx, row, requesterID, bookmark); err != nil {
			return err
		}
	}

	if err := s.verifyRuntimeRepositoryOrigin(ctx, row, requesterID, cloneURL); err != nil {
		return err
	}
	revision, err := s.runtimeRepositoryRevision(ctx, row, requesterID, bookmark)
	if err != nil {
		return err
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
			return pkgerrors.Internal("prepare workspace environment: " + err.Error())
		}
	}
	receipt := workspaceRepositoryReceipt{
		Version: workspaceRepositoryReceiptVersion, WorkspaceID: row.ID, RepositoryID: row.RepositoryID,
		CloneURL: cloneURL, SourceBookmark: bookmark, SourceRevision: revision, InitializedAt: time.Now().UTC(),
	}
	return s.writeRuntimeRepositoryReceipt(ctx, row, requesterID, receipt)
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
		return pkgerrors.Internal("commit workspace repository receipt: " + err.Error())
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

func (s *WorkspaceService) runRuntimeRepositoryCommand(ctx context.Context, row db.Workspace, requesterID int64, step string, command workspaceapi.Command) error {
	operationCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, step)
	if err != nil {
		return err
	}
	execCtx, cancel := context.WithTimeout(operationCtx, workspaceCloneTimeout)
	defer cancel()
	result, err := s.runtime.ExecuteCommand(execCtx, row.ID, command)
	if err != nil {
		return pkgerrors.Internal("initialize workspace repository (" + step + "): " + err.Error())
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
	return pkgerrors.Internal(fmt.Sprintf("initialize workspace repository (%s) failed with status %d: %s", step, result.ExitCode, detail))
}

func (s *WorkspaceService) runtimeRepositoryCommandOutput(ctx context.Context, row db.Workspace, requesterID int64, step string, command workspaceapi.Command) (string, error) {
	operationCtx, err := s.runtimeRepositoryContext(ctx, row, requesterID, step)
	if err != nil {
		return "", err
	}
	execCtx, cancel := context.WithTimeout(operationCtx, workspaceCloneTimeout)
	defer cancel()
	result, err := s.runtime.ExecuteCommand(execCtx, row.ID, command)
	if err != nil {
		return "", pkgerrors.Internal("inspect workspace repository (" + step + "): " + err.Error())
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
	if err := s.runRuntimeRepositoryCommand(ctx, row, requesterID, "fetch", workspaceapi.Command{
		Args: []string{"git", "fetch", "origin", bookmark}, Environment: environment,
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

func (s *WorkspaceService) initializeRuntimeJujutsu(ctx context.Context, row db.Workspace, requesterID int64, bookmark string) error {
	commands := []struct {
		step string
		args []string
		soft bool
	}{
		{step: "jj-init", args: []string{"jj", "git", "init", "--colocate", "."}},
		{step: "jj-track", args: []string{"jj", "bookmark", "track", bookmark + "@origin"}, soft: true},
		{step: "jj-bookmark", args: []string{"jj", "bookmark", "set", bookmark, "-r", bookmark + "@origin"}},
		{step: "jj-working-copy", args: []string{"jj", "new", bookmark}},
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
		!sameWorkspaceRepositoryURL(receipt.CloneURL, cloneURL) || !isLowerHexRevision(receipt.SourceRevision) || receipt.InitializedAt.IsZero() {
		return pkgerrors.Conflict("workspace repository receipt does not match its product repository")
	}
	return nil
}
