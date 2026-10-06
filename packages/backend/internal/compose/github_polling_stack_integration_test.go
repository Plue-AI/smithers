package compose

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/githubfake"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// Only the native repository boundary is replaced. Git's real smart transport,
// the production stack worker, PostgreSQL, GitHub transport and HTTP router run.
// This does not claim native jj or reference-host execution evidence.
type pollingGitHost struct{ dir string }

func (h *pollingGitHost) git(ctx context.Context, input io.Reader, output io.Writer, args ...string) error {
	command := exec.CommandContext(ctx, "git", append([]string{"-c", "core.hooksPath=" + os.DevNull, "-c", "credential.helper=", "--git-dir", h.dir}, args...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.test", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.test")
	command.Stdin, command.Stdout = input, output
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, stderr.String())
	}
	return nil
}
func (h *pollingGitHost) InfoRefs(ctx context.Context, _, _, service string, out io.Writer) (string, error) {
	header := "# service=" + service + "\n"
	_, err := fmt.Fprintf(out, "%04x%s0000", len(header)+4, header)
	if err != nil {
		return "", err
	}
	return "application/x-" + service + "-advertisement", h.git(ctx, nil, out, strings.TrimPrefix(service, "git-"), "--stateless-rpc", "--advertise-refs", h.dir)
}
func (h *pollingGitHost) ProxyUploadPack(ctx context.Context, _, _ string, in io.Reader, out io.Writer) error {
	return h.git(ctx, in, out, "upload-pack", "--stateless-rpc", h.dir)
}
func (h *pollingGitHost) ProxyReceivePack(ctx context.Context, _, _ string, in io.Reader, out io.Writer, metas ...repohost.ReceivePackMetadata) error {
	for _, meta := range metas {
		if meta.VerifyLocked != nil {
			if err := meta.VerifyLocked(ctx); err != nil {
				return err
			}
		}
	}
	return h.git(ctx, in, out, "receive-pack", "--stateless-rpc", h.dir)
}
func (h *pollingGitHost) GetBookmark(ctx context.Context, _, _, name string) (repohost.Bookmark, error) {
	var out bytes.Buffer
	if err := h.git(ctx, nil, &out, "rev-parse", "--verify", "refs/heads/"+name); err != nil {
		return repohost.Bookmark{}, err
	}
	return repohost.Bookmark{Name: name, TargetCommitID: strings.TrimSpace(out.String())}, nil
}
func (h *pollingGitHost) ImportRefs(context.Context, string, string) error { return nil }

func TestInstallPollingTenPullsThroughStackWorker(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	f := newInstallPollingComposition(t, true)
	ctx := t.Context()
	host := &pollingGitHost{dir: filepath.Join(t.TempDir(), "repository.git")}
	require.NoError(t, host.git(ctx, nil, io.Discard, "init", "--bare", host.dir))
	var tree, commit bytes.Buffer
	require.NoError(t, host.git(ctx, strings.NewReader(""), &tree, "mktree"))
	require.NoError(t, host.git(ctx, nil, &commit, "commit-tree", strings.TrimSpace(tree.String()), "-m", "Fixture main"))
	require.NoError(t, host.git(ctx, nil, io.Discard, "update-ref", "refs/heads/main", strings.TrimSpace(commit.String())))
	f.stack = services.NewMythicalService(f.pool, host, services.WithMythicalNow(func() time.Time { return time.Unix(f.clock.Load(), 0).UTC() }))
	composeGitHubTodoPolling(f.stack, f.main, f.sync.synced, topology{})
	f.stack.SetOrchestration(services.NewMythicalGitHub(f.q, f.sync.connections, f.sync.userRepositories, f.sync.connections), nil, nil)
	require.NoError(t, f.stack.PollOnce(ctx))
	stack, err := f.q.GetMythicalStack(ctx, f.repository)
	require.NoError(t, err)
	require.Equal(t, "active", stack.State, stack.LastError)
	installation := int64(351502) + pollingFixtureSequence.Load()
	token, err := f.sync.connections.CreateGitHubInstallationToken(ctx, installation, services.GitHubTokenScope{RepositoryIDs: []int64{100}, Permissions: map[string]string{"pull_requests": "write"}})
	require.NoError(t, err)
	for i := 1; i <= 10; i++ {
		raw, _ := json.Marshal(map[string]string{"title": fmt.Sprint(i), "head": fmt.Sprintf("smithers/%d", i), "base": "main"})
		request, err := http.NewRequest("POST", f.upstream.URL+"/repos/acme/app/pulls", bytes.NewReader(raw))
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer "+token.Token)
		response, err := f.upstream.Client().Do(request)
		require.NoError(t, err)
		require.Equal(t, 201, response.StatusCode)
		require.NoError(t, response.Body.Close())
		head := fmt.Sprintf("%040x", i)
		f.upstream.UpdatePull("acme/app", int64(i), func(p *githubfake.Pull) { p.Head.SHA = head })
		f.upstream.SetCheck("acme/app", head, "ci", "completed", "success")
		item, _, err := f.q.InsertMythicalItem(ctx, db.MythicalItem{RepositoryID: f.repository, State: "proposed", Checks: json.RawMessage(fmt.Sprintf(`{"todo":true,"branch":"smithers/%d"}`, i))})
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `UPDATE mythical_items SET source='todo',number=$2,owner_id=$3,title=$4,attempt=1,pr_number=$2,pr_state='open',pr_url=$5,pr_head=$6,candidate_head=$6,candidate_verified=true WHERE id=$1`, item.ID, i, f.user.ID, fmt.Sprintf("Polling TODO %d", i), fmt.Sprintf("https://github.com/acme/app/pull/%d", i), head)
		require.NoError(t, err)
	}
	for i := 0; i < 100; i++ {
		f.upstream.OpenIssue("acme/app", "acme", fmt.Sprint(i), "body")
	}
	f.start(t)
	require.Eventually(t, func() bool { return f.cached(t, "issues") == 100 }, 10*time.Second, 20*time.Millisecond)
	pass := func() {
		_, err := f.q.RequestMythicalStack(ctx, f.repository)
		require.NoError(t, err)
		require.NoError(t, f.stack.PollOnce(ctx))
	}
	// PostgreSQL stamps fixture rows after migrations and bootstrap. Align the
	// injected clock with those rows before measuring the 45-second cadence.
	f.clock.Store(time.Now().Unix() + 2)
	pass()
	assertReads := func(want int) {
		for i := 1; i <= 10; i++ {
			require.Equal(t, want, f.count("GET /repos/acme/app/pulls/"+strconv.Itoa(i)))
			require.Equal(t, want, f.count(fmt.Sprintf("GET /repos/acme/app/commits/%040x/check-runs", i)))
			require.Equal(t, want, f.count("GET /repos/acme/app/pulls/"+strconv.Itoa(i)+"/reviews"))
		}
	}
	assertReads(1)
	todos := f.readTodos(t)
	require.Len(t, todos, 10)
	for _, todo := range todos {
		require.Equal(t, "in_review", todo["state"])
	}
	f.clock.Add(44)
	pass()
	assertReads(1)
	f.clock.Add(1)
	pass()
	assertReads(2)
	// Budget pressure must not stretch the existing 45-second TODO follow loop.
	f.low.Store(true)
	f.clock.Add(45)
	pass()
	assertReads(3)
	conditional := 0
	for _, read := range f.upstream.Reads() {
		if read.Status == 304 {
			require.NotEmpty(t, read.IfNoneMatch)
			conditional++
		}
	}
	require.GreaterOrEqual(t, conditional, 60)
	var snapshots int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM github_synced_issues WHERE resource='pulls' AND related_facts ? 'checks' AND related_facts ? 'reviews'`).Scan(&snapshots))
	require.Equal(t, 10, snapshots)
	var missingConsumers int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_requests WHERE principal_id IN ('checks','reviews') AND state<>'completed'`).Scan(&missingConsumers))
	require.Equal(t, 20, missingConsumers, "unregistered downstream owners retain their exact snapshots")
}
