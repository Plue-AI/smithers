package repohostserver

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// An install's repository host reserves main and the default bookmark for
// the GitHub sync (Config.InstallMainMirror, repohost.InstallMainRef). The
// sync writes them only by receive-pack; every JSON route that sets or
// deletes a bookmark is refused for them here, under the repository lock.

// installMainRefusal is the §6.2.3 permission envelope of every refusal.
func installMainRefusal(message string) *appError {
	return &appError{StatusCode: http.StatusForbidden, Code: "permission", Class: "permission", Message: message}
}

// refuseInstallMainBookmark refuses a JSON write of bookmark name on an
// install when name is main or the default bookmark. A bookmark, landing or
// repair route carries no credential kind, so no caller is the sync. A
// default that cannot be read refuses every bookmark write.
func (s *Server) refuseInstallMainBookmark(ctx context.Context, repoID, name string) error {
	if !s.config.InstallMainMirror {
		return nil
	}
	owner, repo, err := parseRepoID(repoID)
	if err != nil {
		return err
	}
	gitDir := s.config.GitBackendPath(owner, repo)
	if _, err := os.Stat(gitDir); errors.Is(err, os.ErrNotExist) {
		return nil // no repository: the write itself reports it
	}
	defaultBookmark, err := gitDefaultBookmark(ctx, gitDir)
	if err != nil {
		return installMainRefusal("the bookmark write is refused: the default bookmark cannot be read")
	}
	if err := repohost.RequireInstallMainMirror(true, "", "refs/heads/"+strings.TrimSpace(name), defaultBookmark); err != nil {
		return installMainRefusal(err.Error())
	}
	return nil
}

// refuseInstallMainPush applies repohost.RequireInstallMainMirror to every ref
// a push names and to every ref a symbolic one among them resolves to: git
// receive-pack writes through a symbolic ref, so an alias of main is main.
// It runs under the repository's write lock, before git reads the pack.
func (s *Server) refuseInstallMainPush(ctx context.Context, gitDir string, kind middleware.CredentialKind, commands []repohost.ReceivePackCommand) error {
	if !s.config.InstallMainMirror || kind == middleware.CredentialSync || len(commands) == 0 {
		return nil
	}
	symbolic, err := listSymbolicRefs(ctx, gitDir)
	if err != nil {
		return internalError("failed to list symbolic refs", err)
	}
	var written []string
	for _, command := range commands {
		ref := command.RefName
		for hop := 0; ref != "" && hop <= maxSymbolicRefHops; hop++ {
			written = append(written, ref)
			ref = symbolic[repohost.RefKey(ref)]
		}
		if ref != "" {
			return installMainRefusal("the push is refused: " + command.RefName + " is a symbolic ref chain longer than git follows")
		}
	}
	needsDefault := false
	for _, ref := range written {
		if err := repohost.RequireInstallMainMirror(true, kind, ref, ""); err != nil {
			return installMainRefusal(err.Error())
		}
		needsDefault = needsDefault || strings.HasPrefix(repohost.RefKey(ref), "refs/heads/")
	}
	if !needsDefault {
		return nil
	}
	defaultBookmark, err := gitDefaultBookmark(ctx, gitDir)
	if err != nil {
		return installMainRefusal("the push is refused: the default bookmark cannot be read")
	}
	for _, ref := range written {
		if err := repohost.RequireInstallMainMirror(true, kind, ref, defaultBookmark); err != nil {
			return installMainRefusal(err.Error())
		}
	}
	return nil
}

// maxSymbolicRefHops is git's own limit on following symbolic refs.
const maxSymbolicRefHops = 5

// listSymbolicRefs maps each symbolic ref's RefKey to the ref it names.
// RefKey matches git's lookup on a case-insensitive filesystem, where a
// command naming refs/heads/ALIAS opens the file of refs/heads/alias.
func listSymbolicRefs(ctx context.Context, gitDir string) (map[string]string, error) {
	cmdCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "git", "--git-dir", gitDir, "for-each-ref",
		"--format=%(if)%(symref)%(then)%(refname)%00%(symref)%(end)")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("list symbolic refs: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("list symbolic refs: %w", err)
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, maxRefListingBytes+1))
	tooLarge := int64(len(output)) > maxRefListingBytes
	if tooLarge {
		cancel()
	}
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	switch {
	case tooLarge:
		return nil, fmt.Errorf("list symbolic refs: %w", errRefListingTooLarge)
	case readErr != nil:
		return nil, fmt.Errorf("list symbolic refs: %w", readErr)
	case waitErr != nil:
		return nil, fmt.Errorf("list symbolic refs: %w", waitErr)
	}
	symbolic := map[string]string{}
	for _, line := range strings.Split(string(output), "\n") {
		name, target, ok := strings.Cut(strings.TrimSpace(line), "\x00")
		if ok && name != "" && target != "" {
			symbolic[repohost.RefKey(name)] = target
		}
	}
	return symbolic, nil
}

// refuseInstallMainRepair leaves to the owner, on an install, every planned
// collision whose canonical ref is main or the default bookmark: a repair
// that renames a variant into main, or removes one beside it, is a write of
// main that is not the sync's. Without a readable default nothing is repaired.
func refuseInstallMainRepair(collisions []repohost.RefCaseCollision, defaultBookmark string, defaultReadable bool) {
	for i := range collisions {
		collision := &collisions[i]
		if collision.Action == repohost.RefCaseCollisionReported {
			continue
		}
		if !defaultReadable || repohost.InstallMainRef(collision.Canonical, defaultBookmark) {
			collision.Action, collision.Variants = repohost.RefCaseCollisionReported, nil
		}
	}
}
