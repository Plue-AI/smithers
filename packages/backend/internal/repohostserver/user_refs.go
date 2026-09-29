package repohostserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// Per-user refs, refs/smithers/users/<id>/<name> (#1964), are bounded here
// (#1968): at most Limit refs per user per repository, a pack of at most
// MaxPushBytes per push that writes one, and expiry TTL after the ref's last
// push. Every door (API, SSH, direct) reaches receivePack, so this is the one
// enforcement point.
//
// git keeps no push time, so each repository's git directory holds
// userRefIndexFile, {ref: unix seconds of its last push}, written under the
// repository write lock. A user ref the index does not know is stamped when
// first seen. An expired ref is deleted at the next push that writes a user
// ref, by the periodic sweep, or when it is listed or retained; until then it
// is already treated as absent.
const userRefIndexFile = "smithers-user-refs.json"

// userRefSweepInterval is how often the sweep deletes expired user refs.
var userRefSweepInterval = time.Hour

// userRefNow is the clock user ref expiry reads. Tests replace it.
var userRefNow = time.Now

type userRefPolicy struct {
	limit        int
	maxPushBytes int64
	ttl          time.Duration
}

func (c Config) userRefPolicy() userRefPolicy {
	policy := userRefPolicy{limit: c.UserRefLimit, maxPushBytes: c.UserRefMaxPushBytes, ttl: c.UserRefTTL}
	if policy.limit <= 0 {
		policy.limit = repohost.DefaultUserRefLimit
	}
	if maxBytes := c.maxGitRequestBytes(); policy.maxPushBytes <= 0 || policy.maxPushBytes > maxBytes {
		policy.maxPushBytes = min(repohost.DefaultUserRefMaxPushBytes, maxBytes)
	}
	if policy.ttl <= 0 {
		policy.ttl = repohost.DefaultUserRefTTL
	}
	return policy
}

func readUserRefIndex(gitDir string) (map[string]int64, error) {
	data, err := os.ReadFile(filepath.Join(gitDir, userRefIndexFile))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]int64{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read user ref index: %w", err)
	}
	index := map[string]int64{}
	// A corrupt index only restamps every ref, which lengthens lives; it
	// must not lock the repository's user refs.
	if err := json.Unmarshal(data, &index); err != nil {
		return map[string]int64{}, nil
	}
	return index, nil
}

func writeUserRefIndex(gitDir string, index map[string]int64) error {
	path := filepath.Join(gitDir, userRefIndexFile)
	if len(index) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove user ref index: %w", err)
		}
		return nil
	}
	data, err := json.Marshal(index)
	if err != nil {
		return err
	}
	pending := path + ".pending"
	if err := os.WriteFile(pending, data, 0o644); err != nil {
		return fmt.Errorf("write user ref index: %w", err)
	}
	if err := os.Rename(pending, path); err != nil {
		return fmt.Errorf("write user ref index: %w", err)
	}
	return nil
}

// reconcileUserRefs brings the index in line with refs and deletes expired
// user refs. It must run under the repository write lock. refs is updated in
// place; the answer is the index after reconciliation, already persisted.
func (s *Server) reconcileUserRefs(ctx context.Context, gitDir string, refs map[string]string, keep ...string) (map[string]int64, error) {
	index, err := readUserRefIndex(gitDir)
	if err != nil {
		return nil, err
	}
	now := userRefNow()
	ttl := s.config.userRefPolicy().ttl
	changed := false
	for ref := range index {
		if _, ok := refs[ref]; !ok {
			delete(index, ref)
			changed = true
		}
	}
	for ref, oid := range refs {
		if _, ok := repohost.UserIDFromRef(ref); !ok {
			continue
		}
		pushed, known := index[ref]
		if !known {
			index[ref] = now.Unix()
			changed = true
			continue
		}
		// A ref being pushed or renewed right now is not expired: git still
		// advertises an expired ref until it is deleted, so its owner's
		// lease and renewal name it.
		if now.Before(time.Unix(pushed, 0).Add(ttl)) || slices.Contains(keep, ref) {
			continue
		}
		if err := deleteGitRef(ctx, gitDir, ref, oid); err != nil {
			return nil, err
		}
		delete(refs, ref)
		delete(index, ref)
		changed = true
	}
	if changed {
		if err := writeUserRefIndex(gitDir, index); err != nil {
			return nil, err
		}
	}
	return index, nil
}

func deleteGitRef(ctx context.Context, gitDir, ref, oid string) error {
	output, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "update-ref", "-d", ref, oid).CombinedOutput()
	if err != nil {
		return fmt.Errorf("delete %s: %s", ref, strings.TrimSpace(string(output)))
	}
	return nil
}

// countingReader counts the bytes read through it.
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// dropUserRefs deletes every user ref of a repository and its index.
func dropUserRefs(ctx context.Context, gitDir string) error {
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		return writeUserRefIndex(gitDir, nil)
	}
	refs, err := listGitRefs(ctx, gitDir)
	if err != nil {
		return err
	}
	for ref, oid := range refs {
		if strings.HasPrefix(ref, repohost.UserRefPrefix) {
			if err := deleteGitRef(ctx, gitDir, ref, oid); err != nil {
				return err
			}
		}
	}
	return writeUserRefIndex(gitDir, nil)
}

// userRefPushViolation refuses a push that would leave its pusher more user
// refs than the limit. A push that does not add a ref is never refused, so a
// user over a lowered limit can still update or delete.
func userRefPushViolation(commands []repohost.ReceivePackCommand, refs map[string]string, pusherID int64, limit int) string {
	zero := strings.Repeat("0", 40)
	owned := 0
	for ref := range refs {
		if id, ok := repohost.UserIDFromRef(ref); ok && id == pusherID {
			owned++
		}
	}
	after := owned
	for _, command := range commands {
		if id, ok := repohost.UserIDFromRef(command.RefName); !ok || id != pusherID {
			continue
		}
		_, exists := refs[command.RefName]
		switch {
		case !exists && command.NewOID != zero:
			after++
		case exists && command.NewOID == zero:
			after--
		}
	}
	if after > owned && after > limit {
		return fmt.Sprintf("refs/smithers/users/%d/ holds at most %d refs in a repository; delete one with `smithers repo push --delete --name <name>`", pusherID, limit)
	}
	return ""
}

func writesUserRef(commands []repohost.ReceivePackCommand) bool {
	for _, command := range commands {
		if strings.HasPrefix(command.RefName, repohost.UserRefPrefix) {
			return true
		}
	}
	return false
}

// stampUserRefPushes records the push time of every user ref a successful
// push created or moved and forgets the ones it deleted.
func stampUserRefPushes(gitDir string, commands []repohost.ReceivePackCommand, afterRefs map[string]string) error {
	index, err := readUserRefIndex(gitDir)
	if err != nil {
		return err
	}
	now := userRefNow().Unix()
	for _, command := range commands {
		if _, ok := repohost.UserIDFromRef(command.RefName); !ok {
			continue
		}
		if oid, ok := afterRefs[command.RefName]; ok && oid == command.NewOID {
			index[command.RefName] = now
		} else if !ok {
			delete(index, command.RefName)
		}
	}
	return writeUserRefIndex(gitDir, index)
}

func (s *Server) userRefInfo(ref, oid string, pushed int64) repohost.UserRefInfo {
	_, name, _ := repohost.UserRefName(ref)
	pushedAt := time.Unix(pushed, 0).UTC()
	return repohost.UserRefInfo{Name: name, Ref: ref, CommitID: oid, PushedAt: pushedAt, ExpiresAt: pushedAt.Add(s.config.userRefPolicy().ttl)}
}

// userRefsFor opens a repository for a user ref operation: its git
// directory under the write lock, with expired refs already deleted.
func (s *Server) userRefsFor(r *http.Request, keepName string) (gitDir string, userID int64, refs map[string]string, index map[string]int64, unlock func(), err error) {
	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return "", 0, nil, nil, nil, err
	}
	idText := chi.URLParam(r, "user_id")
	userID, parseErr := strconv.ParseInt(idText, 10, 64)
	if parseErr != nil || userID <= 0 || strconv.FormatInt(userID, 10) != idText {
		return "", 0, nil, nil, nil, badRequest("invalid user id")
	}
	gitDir = s.config.GitBackendPath(owner, repo)
	unlock, err = s.lockRepo(r.Context(), s.config.RepoPath(owner, repo))
	if err != nil {
		return "", 0, nil, nil, nil, err
	}
	fail := func(err error) (string, int64, map[string]string, map[string]int64, func(), error) {
		unlock()
		return "", 0, nil, nil, nil, err
	}
	if _, statErr := os.Stat(gitDir); statErr != nil {
		return fail(notFound("repository not found"))
	}
	refs, err = listGitRefs(r.Context(), gitDir)
	if err != nil {
		return fail(internalError("failed to list refs", err))
	}
	var keep []string
	if keepName != "" {
		keep = append(keep, repohost.UserRef(userID, keepName))
	}
	index, err = s.reconcileUserRefs(r.Context(), gitDir, refs, keep...)
	if err != nil {
		return fail(internalError("failed to expire user refs", err))
	}
	return gitDir, userID, refs, index, unlock, nil
}

// listUserRefs answers GET /repos/{id}/user-refs/{user_id}.
func (s *Server) listUserRefs(w http.ResponseWriter, r *http.Request) error {
	_, userID, refs, index, unlock, err := s.userRefsFor(r, "")
	if err != nil {
		return err
	}
	defer unlock()
	policy := s.config.userRefPolicy()
	result := repohost.UserRefList{Refs: []repohost.UserRefInfo{}, Limit: policy.limit, MaxPushBytes: policy.maxPushBytes, TTLSeconds: int64(policy.ttl / time.Second)}
	for ref, oid := range refs {
		if id, ok := repohost.UserIDFromRef(ref); ok && id == userID {
			result.Refs = append(result.Refs, s.userRefInfo(ref, oid, index[ref]))
		}
	}
	sort.Slice(result.Refs, func(i, j int) bool { return result.Refs[i].Name < result.Refs[j].Name })
	return writeJSON(w, http.StatusOK, result)
}

// retainUserRef answers POST /repos/{id}/user-refs/{user_id}/retain: it pins
// the named ref's commit under the workspace's source ref, which the
// workspace's native import accepts and which outlives the user ref.
func (s *Server) retainUserRef(w http.ResponseWriter, r *http.Request) error {
	var req repohost.RetainUserRefRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if !repohost.ValidUserRefName(req.Name) {
		return badRequest("invalid user ref name")
	}
	if _, _, ok := repohost.WorkspaceSourceFromRef(repohost.WorkspaceSourceRef(req.WorkspaceID, strings.Repeat("a", 40))); !ok {
		return badRequest("invalid workspace id")
	}
	gitDir, userID, refs, index, unlock, err := s.userRefsFor(r, "")
	if err != nil {
		return err
	}
	defer unlock()
	ref := repohost.UserRef(userID, req.Name)
	if _, ok := refs[ref]; !ok {
		return userRefMissing(ref)
	}
	// git accepts any object under a ref; a workspace source is a commit.
	peeled, err := exec.CommandContext(r.Context(), "git", "--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "--end-of-options", ref+"^{commit}").Output()
	oid := strings.TrimSpace(string(peeled))
	if err != nil || !validGitObjectID(oid) {
		return &appError{StatusCode: http.StatusConflict, Code: "user_ref_not_commit", Message: ref + " does not name a commit"}
	}
	sourceRef := repohost.WorkspaceSourceRef(req.WorkspaceID, oid)
	if current, exists := refs[sourceRef]; !exists {
		output, err := exec.CommandContext(r.Context(), "git", "--git-dir", gitDir, "update-ref", sourceRef, oid, strings.Repeat("0", 40)).CombinedOutput()
		if err != nil {
			return internalError("failed to retain the user ref", errors.New(strings.TrimSpace(string(output))))
		}
	} else if current != oid {
		return conflict("the workspace source ref names another commit")
	}
	return writeJSON(w, http.StatusOK, repohost.RetainedUserRef{UserRefInfo: s.userRefInfo(ref, oid, index[ref]), SourceRef: sourceRef})
}

func userRefMissing(ref string) *appError {
	return &appError{StatusCode: http.StatusNotFound, Code: "user_ref_missing", Message: ref + " does not exist or expired"}
}

// renewUserRef answers POST /repos/{id}/user-refs/{user_id}/renew: a push
// of an unchanged commit sends git nothing, so `smithers repo push` renews
// the ref's expiry here instead.
func (s *Server) renewUserRef(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Name string `json:"name"`
	}
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	if !repohost.ValidUserRefName(req.Name) {
		return badRequest("invalid user ref name")
	}
	gitDir, userID, refs, index, unlock, err := s.userRefsFor(r, req.Name)
	if err != nil {
		return err
	}
	defer unlock()
	ref := repohost.UserRef(userID, req.Name)
	oid, ok := refs[ref]
	if !ok {
		return userRefMissing(ref)
	}
	index[ref] = userRefNow().Unix()
	if err := writeUserRefIndex(gitDir, index); err != nil {
		return internalError("failed to renew the user ref", err)
	}
	return writeJSON(w, http.StatusOK, s.userRefInfo(ref, oid, index[ref]))
}

// startUserRefSweep deletes expired user refs in every repository with an
// index, once per interval, until Shutdown.
func (s *Server) startUserRefSweep(interval time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	s.stopSweep = cancel
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			s.sweepUserRefs(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *Server) sweepUserRefs(ctx context.Context) {
	indexes, err := filepath.Glob(filepath.Join(s.config.StoragePath, "*", "*", ".jj", "repo", "store", "git", userRefIndexFile))
	if err != nil {
		return
	}
	for _, path := range indexes {
		if ctx.Err() != nil {
			return
		}
		gitDir := filepath.Dir(path)
		repoPath := repositoryPathOf(gitDir)
		if s.locks.Held(repoPath) {
			continue
		}
		func() {
			unlock, err := s.lockRepo(ctx, repoPath)
			if err != nil {
				return
			}
			defer unlock()
			// The repository may have moved or gone while the sweep waited.
			if _, err := os.Stat(filepath.Join(gitDir, userRefIndexFile)); err != nil {
				return
			}
			refs, err := listGitRefs(ctx, gitDir)
			if err == nil {
				_, err = s.reconcileUserRefs(ctx, gitDir, refs)
			}
			if err != nil && s.logger != nil {
				s.logger.Warn("user ref sweep failed", "repo", repoPath, "error", err)
			}
		}()
	}
}
