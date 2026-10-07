package githubfake

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// PushActivity is one push GitHub's repository activity lists
// (GET /repos/{owner}/{repo}/activity): the ref, its old and new heads and
// the actor who pushed.
type PushActivity struct {
	ID           int64          `json:"id"`
	NodeID       string         `json:"node_id"`
	Before       string         `json:"before"`
	After        string         `json:"after"`
	Ref          string         `json:"ref"`
	Timestamp    time.Time      `json:"timestamp"`
	ActivityType string         `json:"activity_type"`
	Actor        map[string]any `json:"actor"`
}

// PushAs commits files (root paths only) onto branch of repo's Git fixture
// as login, GitHub account id, and records the push in the repository's
// activity, as a person pushing from a laptop would. It answers the commit.
func (s *Server) PushAs(repo, branch string, id int64, login, message string, files map[string]string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, hosted := s.gitDir(repo)
	if !hosted {
		return "", fmt.Errorf("githubfake: %s has no Git fixture", repo)
	}
	run := func(stdin string, args ...string) (string, error) {
		cmd := exec.Command("/usr/bin/git", append([]string{"--git-dir", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
			"GIT_AUTHOR_NAME="+login, "GIT_AUTHOR_EMAIL="+login+"@users.noreply.github.com",
			"GIT_COMMITTER_NAME="+login, "GIT_COMMITTER_EMAIL="+login+"@users.noreply.github.com")
		cmd.Stdin = strings.NewReader(stdin)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
		}
		return strings.TrimSpace(string(out)), nil
	}
	ref := "refs/heads/" + branch
	before, err := run("", "rev-parse", "--verify", ref)
	if err != nil {
		return "", err
	}
	listing, err := run("", "ls-tree", before)
	if err != nil {
		return "", err
	}
	entries := map[string]string{}
	for _, line := range strings.Split(listing, "\n") {
		if meta, path, ok := strings.Cut(line, "\t"); ok {
			entries[path] = meta
		}
	}
	for path, content := range files {
		if path == "" || strings.Contains(path, "/") {
			return "", fmt.Errorf("githubfake: PushAs writes root paths only, not %q", path)
		}
		blob, err := run(content, "hash-object", "-w", "--stdin")
		if err != nil {
			return "", err
		}
		entries[path] = "100644 blob " + blob
	}
	var tree strings.Builder
	for path, meta := range entries {
		tree.WriteString(meta + "\t" + path + "\n")
	}
	treeID, err := run(tree.String(), "mktree")
	if err != nil {
		return "", err
	}
	after, err := run("", "commit-tree", treeID, "-p", before, "-m", message)
	if err != nil {
		return "", err
	}
	if _, err := run("", "update-ref", ref, after, before); err != nil {
		return "", err
	}
	s.eventIDs++
	s.activity[repo] = append(s.activity[repo], PushActivity{ID: s.eventIDs, NodeID: fmt.Sprintf("RA_%d", s.eventIDs), Before: before, After: after, Ref: ref,
		Timestamp: time.Now().UTC(), ActivityType: "push", Actor: map[string]any{"id": id, "login": login, "type": "User"}})
	return after, nil
}

// repositoryActivity answers GitHub's repository activity list for ref,
// newest first. Called under the lock.
func (s *Server) repositoryActivity(r *http.Request, repo string) (int, any) {
	ref := r.URL.Query().Get("ref")
	if ref != "" && !strings.HasPrefix(ref, "refs/") {
		ref = "refs/heads/" + ref
	}
	events := []PushActivity{}
	for i := len(s.activity[repo]) - 1; i >= 0; i-- {
		if event := s.activity[repo][i]; ref == "" || event.Ref == ref {
			events = append(events, event)
		}
	}
	if limit, err := strconv.Atoi(r.URL.Query().Get("per_page")); err == nil && limit > 0 && limit < len(events) {
		events = events[:limit]
	}
	return http.StatusOK, events
}
