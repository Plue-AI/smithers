package repohostserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/ownership"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// pathInspectCommandContext builds the git process that inspects pushed
// history. Tests swap it to inject inspection failures.
var pathInspectCommandContext = exec.CommandContext

// pushPathEnforcementTimeout bounds each post-publication step (ref listing,
// history inspection, rollback) once git receive-pack has written refs. The
// steps run on a context detached from the request: a client that hangs up
// after git published its refs must still get them authorized or undone.
const pushPathEnforcementTimeout = 2 * time.Minute

// detachedPushContext returns a context that survives the request's
// cancellation but is bounded by pushPathEnforcementTimeout.
func detachedPushContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), pushPathEnforcementTimeout)
}

// acceptedRefPrefixes are the namespaces whose commits count as content the
// repository has already accepted. They seed the exclusions when inspecting
// a push and mirror the namespaces pushHookPayloadsFromRefDiff publishes.
// refs/jj/keep/* is deliberately absent: jj writes one of those retention
// pins for every commit it knows about, so if they seeded the exclusions a
// commit dropped from a branch, or one that never reached a branch, would
// look already published and escape inspection.
var acceptedRefPrefixes = []string{"refs/heads/", "refs/tags/"}

func pushPathAllowlist(headers http.Header) ([]string, bool, error) {
	raw := strings.TrimSpace(headers.Get("X-Smithers-Allowed-Paths"))
	if raw == "" {
		return nil, false, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, true, badRequest("malformed push path allowlist")
	}
	var paths []string
	if err := json.Unmarshal(decoded, &paths); err != nil || len(paths) == 0 {
		return nil, true, badRequest("malformed push path allowlist")
	}
	return paths, true, nil
}

// enforcePushPathAllowlist authorizes the ref updates git already applied
// (before -> after) against the lane's path allowlist. It fails closed: a
// denied push, and a push whose history could not be inspected, are both
// rolled back to before, and neither inspection nor rollback is abandoned
// when the caller's context is cancelled.
func enforcePushPathAllowlist(ctx context.Context, gitDir string, before, after map[string]string, allowed []string) error {
	inspectCtx, cancelInspect := detachedPushContext(ctx)
	defer cancelInspect()
	changed, err := changedPathsForRefUpdates(inspectCtx, gitDir, before, after)
	if err != nil {
		// Rollback gets its own budget so a slow inspection cannot starve it.
		restoreCtx, cancelRestore := detachedPushContext(ctx)
		defer cancelRestore()
		if restoreErr := restoreGitRefs(restoreCtx, gitDir, before, after); restoreErr != nil {
			return internalError("failed to roll back uninspected push", errors.Join(err, restoreErr))
		}
		return internalError("failed to inspect pushed paths", err)
	}
	var denied []string
	for _, filePath := range changed {
		permitted := false
		for _, pattern := range allowed {
			if ownership.Match(pattern, filePath) {
				permitted = true
				break
			}
		}
		if !permitted {
			denied = append(denied, filePath)
		}
	}
	if len(denied) == 0 {
		return nil
	}
	restoreCtx, cancelRestore := detachedPushContext(ctx)
	defer cancelRestore()
	if err := restoreGitRefs(restoreCtx, gitDir, before, after); err != nil {
		return internalError("failed to roll back disallowed push", err)
	}
	sort.Strings(denied)
	return forbidden("push touches paths outside the agent lane: " + strings.Join(denied, ", "))
}

// changedPathsForRefUpdates lists every path whose content the push changed
// in the repository's accepted history, in either direction:
//
//   - introduced: commits that became reachable from a written ref and were
//     not reachable from any accepted ref before the push. This covers new
//     refs, fast-forwards, and the new side of a force push, and it inspects
//     every commit rather than the net tree diff so a denied write cannot be
//     smuggled into an intermediate commit and reverted at the tip.
//   - dropped: commits that a rewound or deleted ref made unreachable from
//     every accepted ref. Erasing an out-of-lane commit rewrites those paths
//     as surely as a commit that deletes them.
//
// Each commit is listed with every path it touched, deletions and both sides
// of a rename included; merge commits list only paths whose result differs
// from every parent, so a clean merge of already-accepted commits adds
// nothing while an evil merge is caught.
func changedPathsForRefUpdates(ctx context.Context, gitDir string, before, after map[string]string) ([]string, error) {
	seen := map[string]struct{}{}
	if err := collectTouchedPaths(ctx, gitDir, changedRefOIDs(after, before), acceptedRefOIDs(before), seen); err != nil {
		return nil, fmt.Errorf("inspect introduced commits: %w", err)
	}
	if err := collectTouchedPaths(ctx, gitDir, changedRefOIDs(before, after), acceptedRefOIDs(after), seen); err != nil {
		return nil, fmt.Errorf("inspect dropped commits: %w", err)
	}
	out := make([]string, 0, len(seen))
	for filePath := range seen {
		out = append(out, filePath)
	}
	sort.Strings(out)
	return out, nil
}

// changedRefOIDs returns the object ids of refs in from whose value is
// absent from, or different in, to.
func changedRefOIDs(from, to map[string]string) []string {
	seen := map[string]struct{}{}
	var oids []string
	for refName, oid := range from {
		if other, ok := to[refName]; ok && other == oid {
			continue
		}
		if _, dup := seen[oid]; dup {
			continue
		}
		seen[oid] = struct{}{}
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	return oids
}

// acceptedRefOIDs returns the object ids of the refs under acceptedRefPrefixes.
func acceptedRefOIDs(refs map[string]string) []string {
	seen := map[string]struct{}{}
	var oids []string
	for refName, oid := range refs {
		accepted := false
		for _, prefix := range acceptedRefPrefixes {
			if strings.HasPrefix(refName, prefix) {
				accepted = true
				break
			}
		}
		if !accepted {
			continue
		}
		if _, dup := seen[oid]; dup {
			continue
		}
		seen[oid] = struct{}{}
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	return oids
}

// collectTouchedPaths adds to seen every path touched by the commits
// reachable from include but not from exclude. Revisions go through --stdin
// so a repository with many refs cannot overflow the argument list, and
// paths come back NUL-terminated so git's quoting of unusual names cannot
// change what the lane match sees.
func collectTouchedPaths(ctx context.Context, gitDir string, include, exclude []string, seen map[string]struct{}) error {
	if len(include) == 0 {
		return nil
	}
	var revisions strings.Builder
	for _, oid := range include {
		revisions.WriteString(oid)
		revisions.WriteByte('\n')
	}
	for _, oid := range exclude {
		revisions.WriteByte('^')
		revisions.WriteString(oid)
		revisions.WriteByte('\n')
	}
	cmd := hostexec.GitWith(ctx, pathInspectCommandContext, "--git-dir", gitDir, "log", "--stdin", "--format=", "--name-only", "--no-renames", "-c", "--no-color", "-z")
	cmd.Stdin = strings.NewReader(revisions.String())
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return fmt.Errorf("git log: %w: %s", err, strings.TrimSpace(string(exitErr.Stderr)))
		}
		return fmt.Errorf("git log: %w", err)
	}
	for _, filePath := range bytes.Split(out, []byte{0}) {
		if len(filePath) > 0 {
			seen[string(filePath)] = struct{}{}
		}
	}
	return nil
}

// restoreGitRefs puts every ref the push changed back to its before value
// in one `git update-ref --stdin` transaction. Only refs whose value differs
// between the listings are written, so a repository holding thousands of
// refs/jj/keep/* pins still rolls back with a single git process. Each
// command names the after value as the expected old value: a ref that moved
// again since the listing aborts the whole transaction instead of being
// clobbered.
func restoreGitRefs(ctx context.Context, gitDir string, before, after map[string]string) error {
	var commands bytes.Buffer
	for _, refName := range sortedRefNames(before, after) {
		oldOID, existed := before[refName]
		newOID, exists := after[refName]
		switch {
		case existed && exists && oldOID == newOID:
			continue
		case existed && exists:
			fmt.Fprintf(&commands, "update %s\x00%s\x00%s\x00", refName, oldOID, newOID)
		case existed:
			fmt.Fprintf(&commands, "create %s\x00%s\x00", refName, oldOID)
		default:
			fmt.Fprintf(&commands, "delete %s\x00%s\x00", refName, newOID)
		}
	}
	if commands.Len() == 0 {
		return nil
	}
	cmd := hostexec.Git(ctx, "--git-dir", gitDir, "update-ref", "--stdin", "-z")
	cmd.Stdin = &commands
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("restore refs: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// sortedRefNames returns the union of both listings' ref names, sorted so
// the rollback transaction is deterministic.
func sortedRefNames(a, b map[string]string) []string {
	names := make([]string, 0, len(a))
	for name := range a {
		names = append(names, name)
	}
	for name := range b {
		if _, ok := a[name]; !ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func rollBackPublishedPush(ctx context.Context, gitDir string, before, after map[string]string, cause error) error {
	restoreCtx, cancelRestore := detachedPushContext(ctx)
	defer cancelRestore()
	if err := restoreGitRefs(restoreCtx, gitDir, before, after); err != nil {
		return internalError("failed to roll back rejected push", errors.Join(cause, err))
	}
	return cause
}

// rollBackUnlistablePush handles a path-restricted push whose post-receive
// ref listing failed: nothing can be authorized, so every ref the client's
// command list named is put back to its pre-push value (or deleted when it
// did not exist). A command list that failed to parse names no ref git could
// have applied. The returned error carries both failures.
func rollBackUnlistablePush(ctx context.Context, gitDir string, listErr error, commands []repohost.ReceivePackCommand, before map[string]string) error {
	restoreCtx, cancelRestore := detachedPushContext(ctx)
	defer cancelRestore()
	var restoreErr error
	for _, command := range commands {
		refName := strings.TrimSpace(command.RefName)
		if refName == "" {
			continue
		}
		var cmd *exec.Cmd
		if oldOID, existed := before[refName]; existed {
			cmd = hostexec.Git(restoreCtx, "--git-dir", gitDir, "update-ref", refName, oldOID)
		} else {
			cmd = hostexec.Git(restoreCtx, "--git-dir", gitDir, "update-ref", "-d", refName)
		}
		if out, err := cmd.CombinedOutput(); err != nil {
			restoreErr = errors.Join(restoreErr, fmt.Errorf("restore %s: %w: %s", refName, err, strings.TrimSpace(string(out))))
		}
	}
	if restoreErr != nil {
		return internalError("failed to roll back unverifiable push", errors.Join(listErr, restoreErr))
	}
	return internalError("failed to inspect pushed refs", listErr)
}
