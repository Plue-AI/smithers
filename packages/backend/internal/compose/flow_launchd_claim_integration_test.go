package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/stretchr/testify/require"
)

// This qualifies the served claim through the shipped CLI and launchd, using
// the owner's supported network policy. It is step-8 evidence only: a claimed
// install is not evidence of a TODO, canary execution or guest interruption.
func TestCSEC02LaunchdServedClaim(t *testing.T) {
	bundle := os.Getenv("SMITHERS_CHECK_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE required for launchd served claim")
		}
		t.Skip("requires real darwin-arm64 bundle and unprivileged launchd login")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotZero(t, os.Getuid())
	approved, err := installbundle.Open(bundle)
	require.NoError(t, err)
	cli, err := approved.Expect("shipped CLI", approved.Path("bin/smthrs"), "bin/smthrs", true)
	require.NoError(t, err)
	domain := fmt.Sprintf("gui/%d/sh.smithers.host", os.Getuid())
	// Never stop or replace a service this test did not start.
	require.Error(t, exec.Command("/bin/launchctl", "print", domain).Run(), "stop the existing install before qualification")
	listener, err := net.Listen("tcp", "127.0.0.1:4000")
	require.NoError(t, err, "reference-host install port must be unoccupied")
	require.NoError(t, listener.Close())
	// launchd's setup handoff uses a Unix socket. Go's macOS test temp
	// directory has a long /var/folders prefix, so keep the private home in
	// the checkout, as the existing host-service qualification does.
	repository, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	home, err := os.MkdirTemp(repository, ".c2-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(home)) })
	home, err = filepath.EvalSymlinks(home)
	require.NoError(t, err)
	_, err = installbundle.ProtectedDirectory("qualification home", home)
	require.NoError(t, err)
	require.LessOrEqual(t, len(filepath.Join(home, "Library", "Application Support", "Smithers", "run", "host.sock")), 103, "reference-host checkout path is too long for the Unix setup socket")
	root := home
	proxy, ca := isolationGitHubProxy(t, root)
	environment := []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HTTPS_PROXY=" + proxy, "NO_PROXY=localhost,127.0.0.1", "SSL_CERT_FILE=" + ca, "SMITHERS_WORKSPACE_ISOLATION=process", "SMITHERS_MICROSANDBOX_BIN=/bin/false"}
	run := func(args ...string) ([]byte, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, cli, append([]string{"host"}, args...)...)
		command.Env = environment
		// Do not put raw setup URLs or CLI output into failure messages.
		return command.Output()
	}
	// Registered before start so partial bootstraps are cleaned too. The
	// service label was independently verified absent before this test.
	t.Cleanup(func() { _, err := run("stop", "--json"); require.NoError(t, err) })
	output, err := run("start", "--bundle", approved.Root(), "--json")
	require.NoError(t, err)
	var printed struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal(output, &printed))
	require.Len(t, printed.URLs, 1)
	setup, err := url.Parse(printed.URLs[0])
	require.NoError(t, err)
	token := setup.Query().Get("token")
	require.Len(t, token, 64)
	job, err := exec.Command("/bin/launchctl", "print", domain).Output()
	require.NoError(t, err)
	match := strings.Fields(string(job))
	pid := 0
	for index := 0; index+2 < len(match); index++ {
		if match[index] == "pid" && match[index+1] == "=" {
			pid, _ = strconv.Atoi(match[index+2])
			break
		}
	}
	require.Positive(t, pid)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	isolationChildInventory(t, ctx, pid, approved.Root())
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	isolationClaimOwner(t, client, "127.0.0.1:4000", token, "http://localhost:4000", "isolation-owner", true)
	_, err = run("stop", "--json")
	require.NoError(t, err)
	output, err = run("start", "--bundle", approved.Root(), "--json")
	// The person-facing CLI reports already claimed with exit 3, while the
	// service remains healthy and publishes no fresh setup authority.
	var exit *exec.ExitError
	require.ErrorAs(t, err, &exit)
	require.Equal(t, 3, exit.ExitCode())
	require.False(t, strings.Contains(string(output), token), "post-claim output exposes the setup token")
	require.NotContains(t, string(output), "setup_urls")
	response, err := client.Get("http://127.0.0.1:4000/readyz")
	require.NoError(t, err)
	_, err = io.Copy(io.Discard, response.Body)
	require.NoError(t, err)
	require.NoError(t, response.Body.Close())
	require.Equal(t, http.StatusOK, response.StatusCode)
	_, err = run("stop", "--json")
	require.NoError(t, err)
	logs, err := os.ReadFile(filepath.Join(home, "Library", "Application Support", "Smithers", "logs", "host.log"))
	require.NoError(t, err)
	require.False(t, strings.Contains(string(logs), token), "ordinary logs expose the setup token")
	require.NotContains(t, string(logs), "setup_urls")
	if directory := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR"); directory != "" {
		require.NoError(t, os.MkdirAll(directory, 0700))
		receipt, err := json.Marshal(map[string]any{"revision": approved.Revision(), "manifestSHA256": approved.ManifestSHA256(), "launchdServedOAuthClaim": true, "postClaimRestartSilent": true, "tokenAbsentFromLogs": true, "pending": []string{"TODO and canary lifecycle", "owned guest interruption"}})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(directory, "launchd-served-claim.json"), append(receipt, '\n'), 0600))
	}
}
