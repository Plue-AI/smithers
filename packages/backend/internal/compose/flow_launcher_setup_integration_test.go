package compose

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
	"github.com/stretchr/testify/require"
)

type isolationOutput struct {
	sync.Mutex
	bytes.Buffer
}

func (b *isolationOutput) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *isolationOutput) snapshot() string { b.Lock(); defer b.Unlock(); return b.Buffer.String() }

// Qualifies real launcher stdout and served OAuth claim, without tapping the
// backend pipe or synthesizing owner rows.
func TestCSEC02BundledLauncherSetupRotation(t *testing.T) {
	bundle := os.Getenv("SMITHERS_CHECK_BUNDLE")
	if bundle == "" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("SMITHERS_CHECK_BUNDLE required for launcher setup rotation")
		}
		t.Skip("requires real darwin-arm64 install bundle")
	}
	require.Equal(t, "darwin", runtime.GOOS)
	require.Equal(t, "arm64", runtime.GOARCH)
	require.NotZero(t, os.Getuid(), "qualification requires an unprivileged login")
	approved, err := installbundle.Open(bundle)
	require.NoError(t, err)
	_, err = approved.Expect("bundled launcher", approved.Path("bin/smithers-server"), "bin/smithers-server", true)
	require.NoError(t, err)
	root := bundletest.ProtectedTempDir(t)
	home := filepath.Join(root, "home")
	require.NoError(t, os.Mkdir(home, 0700))
	hostileBin := filepath.Join(home, "bin")
	require.NoError(t, os.Mkdir(hostileBin, 0700))
	marker := filepath.Join(home, "unapproved-executable")
	markerShell := "'" + strings.ReplaceAll(marker, "'", "'\"'\"'") + "'"
	for _, name := range []string{"node", "bun", "msb", "git", "postgres"} {
		require.NoError(t, os.WriteFile(filepath.Join(hostileBin, name), []byte("#!/bin/sh\nprintf invoked > "+markerShell+"\nexit 97\n"), 0700))
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	state := filepath.Join(home, "Library", "Application Support", "Smithers")
	proxy, caFile := isolationGitHubProxy(t, root)
	tokens := []string{}
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for attempt := 0; attempt < 3; attempt++ {
		func() {
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, approved.Path("bin/smithers-server"), "--bind", address)
			cmd.Env = []string{"HOME=" + home, "PATH=" + hostileBin + ":/opt/homebrew/bin:/usr/bin:/bin", "SMITHERS_BACKEND_MODE=plue", "SMITHERS_WORKSPACE_ISOLATION=process", "SMITHERS_MICROSANDBOX_BIN=/bin/false", "HTTPS_PROXY=" + proxy, "NO_PROXY=localhost,127.0.0.1", "SSL_CERT_FILE=" + caFile}
			var stdout, stderr isolationOutput
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr
			require.NoError(t, cmd.Start())
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			stopped := false
			stop := func() {
				if stopped {
					return
				}
				stopped = true
				_ = cmd.Process.Signal(syscall.SIGTERM)
				select {
				case err := <-done:
					require.NoError(t, err, "launcher must stop cleanly")
				case <-time.After(30 * time.Second):
					_ = cmd.Process.Kill()
					<-done
					t.Error("launcher shutdown exceeded 30 seconds")
				}
			}
			defer stop()
			require.Eventually(t, func() bool {
				response, err := client.Get("http://" + address + "/readyz")
				if err != nil {
					return false
				}
				defer response.Body.Close()
				return response.StatusCode == 200
			}, 60*time.Second, 100*time.Millisecond, "real bundled launcher must reach readiness")
			isolationChildInventory(t, ctx, cmd.Process.Pid, approved.Root())
			output := stdout.snapshot()
			if attempt == 2 {
				require.NotContains(t, output, `"setup_urls"`, "claimed install emits no setup token")
				stop()
				require.NotContains(t, stdout.snapshot(), `"setup_urls"`)
				for _, secret := range tokens {
					require.NotContains(t, stdout.snapshot(), secret)
					require.NotContains(t, stderr.snapshot(), secret)
				}
				return
			}
			var setupLine, token string
			count := 0
			for _, line := range strings.SplitAfter(output, "\n") {
				if !strings.HasPrefix(line, `{"setup_urls":`) {
					continue
				}
				count++
				require.True(t, strings.HasSuffix(line, "\n"), "setup emission must be newline terminated")
				var document map[string]json.RawMessage
				require.NoError(t, json.Unmarshal([]byte(line), &document))
				require.Len(t, document, 1)
				var urls []string
				require.NoError(t, json.Unmarshal(document["setup_urls"], &urls))
				origins := []string{"http://localhost:4000"}
				if attempt == 1 {
					origins = append(origins, "http://lan-a:4000", "https://box.example")
				}
				require.Len(t, urls, len(origins))
				for index, raw := range urls {
					parsed, err := url.Parse(raw)
					require.NoError(t, err)
					require.Equal(t, origins[index], parsed.Scheme+"://"+parsed.Host)
					require.Equal(t, "/setup", parsed.Path)
					current := parsed.Query().Get("token")
					require.Len(t, current, 64)
					if token == "" {
						token = current
					}
					require.True(t, current == token, "all setup origins share one token")
				}
				setupLine = line
			}
			require.Equal(t, 1, count, "exactly one setup line per pre-claim launch")
			tokens = append(tokens, token)
			pidBytes, err := os.ReadFile(filepath.Join(state, "postgres", "data", "postmaster.pid"))
			require.NoError(t, err)
			fields := strings.Split(string(pidBytes), "\n")
			require.GreaterOrEqual(t, len(fields), 4)
			password, err := os.ReadFile(filepath.Join(state, "postgres", "password"))
			require.NoError(t, err)
			connection := url.URL{Scheme: "postgres", User: url.UserPassword("smithers", string(password)), Host: net.JoinHostPort("127.0.0.1", fields[3]), Path: "/postgres", RawQuery: "sslmode=disable"}
			database, err := pgx.Connect(ctx, connection.String())
			require.NoError(t, err)
			defer database.Close(context.Background())
			var digest string
			require.NoError(t, database.QueryRow(ctx, `SELECT value #>> '{}' FROM install_settings WHERE key='setup.token'`).Scan(&digest))
			require.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(token))), digest, "printed token independently matches stored digest")
			if attempt == 0 {
				_, err = database.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES ('public_origins','["http://lan-a:4000","https://box.example"]'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
				require.NoError(t, err)
			} else {
				require.True(t, tokens[0] != token, "pre-claim restart must rotate")
				request, err := http.NewRequest(http.MethodGet, "http://"+address+"/setup?token="+url.QueryEscape(tokens[0]), nil)
				require.NoError(t, err)
				request.Host = "localhost:4000"
				response, err := client.Do(request)
				require.NoError(t, err)
				_, err = io.Copy(io.Discard, response.Body)
				require.NoError(t, err)
				require.NoError(t, response.Body.Close())
				require.Equal(t, http.StatusUnauthorized, response.StatusCode, "old token refused by served exchange")
				// Step 8 is an isolated credential qualification, not a full setup
				// journey. Preserve the explicit-port launcher fixture and seed only
				// Address completion; the owner is still claimed through served OAuth.
				_, err = database.Exec(ctx, `UPDATE install_settings SET value='{"status":"done"}'::jsonb WHERE key='setup.step.address'`)
				require.NoError(t, err)
				isolationClaimOwner(t, client, address, token, "http://localhost:4000", "isolation-owner", false)
				var owners int
				require.NoError(t, database.QueryRow(ctx, `SELECT count(*) FROM self_host_owners`).Scan(&owners))
				require.Equal(t, 1, owners, "served OAuth persists the owner before restart")
			}
			stop()
			_, markerErr := os.Stat(marker)
			require.ErrorIs(t, markerErr, os.ErrNotExist, "launcher must never execute a shell-selected program")
			require.Equal(t, 1, strings.Count(stdout.snapshot(), `{"setup_urls":`), "no additional emission during shutdown")
			outside := strings.Replace(stdout.snapshot(), setupLine, "", 1)
			for _, secret := range tokens {
				require.False(t, strings.Contains(outside, secret), "setup token outside printed line")
				require.False(t, strings.Contains(stderr.snapshot(), secret), "setup token in launcher stderr")
			}
			require.NoError(t, filepath.WalkDir(state, func(path string, entry os.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".log") {
					return nil
				}
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				for _, secret := range tokens {
					require.False(t, bytes.Contains(data, []byte(secret)), "setup token in ordinary logs")
				}
				return nil
			}))
		}()
	}
	require.NoError(t, filepath.WalkDir(state, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".log") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, token := range tokens {
			require.False(t, bytes.Contains(data, []byte(token)), "setup token in post-claim logs")
		}
		return nil
	}))
	if evidence := os.Getenv("SMITHERS_FLOW_ISOLATION_EVIDENCE_DIR"); evidence != "" {
		require.NoError(t, os.MkdirAll(evidence, 0700))
		receipt, err := json.Marshal(map[string]any{"revision": approved.Revision(), "manifestSHA256": approved.ManifestSHA256(), "launcherEmissions": 2, "digestMatched": true, "rotated": true, "oldTokenRefused": true, "tokensAbsentOutsidePrintedLine": true, "servedOAuthClaim": true, "postClaimSilent": true, "childPathAndLibrariesQualified": true, "pending": []string{"TODO and canary lifecycle"}})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(evidence, "launcher-setup-rotation.json"), append(receipt, '\n'), 0600))
	}
}

// Every mutation goes through the install router with its setup cookie and CSRF
// token. Readiness is not a setup completion receipt.
func isolationClaimOwner(t *testing.T, base *http.Client, address, token, origin, owner string, configureAddress bool) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := *base
	client.Jar = jar
	originURL, err := url.Parse(origin)
	require.NoError(t, err)
	request := func(method, path, body string, status int) ([]byte, string) {
		t.Helper()
		req, err := http.NewRequest(method, "http://"+address+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Host = originURL.Host
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", "csec02-"+path)
		for _, cookie := range jar.Cookies(req.URL) {
			if cookie.Name == "__csrf" {
				req.Header.Set("X-CSRF-Token", cookie.Value)
			}
		}
		response, err := client.Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		require.NoError(t, err)
		// Never include a response body in failure output: it may contain a token.
		require.Equal(t, status, response.StatusCode, "served %s %s", method, strings.Split(path, "?")[0])
		return data, response.Header.Get("Location")
	}
	request("GET", "/setup?token="+url.QueryEscape(token), "", 303)
	request("GET", "/api/install", "", 200)
	if configureAddress {
		body, err := json.Marshal(map[string]any{"bind": "127.0.0.1:4000", "origins": []string{origin, "http://lan-a:4000", "https://box.example"}})
		require.NoError(t, err)
		request("POST", "/api/install/setup/address", string(body), 202)
		require.Eventually(t, func() bool {
			data, _ := request("GET", "/api/install", "", 200)
			var status struct{ Steps []struct{ ID, State string } }
			require.NoError(t, json.Unmarshal(data, &status))
			for _, step := range status.Steps {
				if step.ID == "address" {
					return step.State == "done"
				}
			}
			return false
		}, 10*time.Second, 100*time.Millisecond)
	}
	appBody, err := json.Marshal(map[string]string{"owner": owner})
	require.NoError(t, err)
	data, _ := request("POST", "/api/install/setup/app", string(appBody), 200)
	var manifest struct{ State string }
	require.NoError(t, json.Unmarshal(data, &manifest))
	require.NotEmpty(t, manifest.State)
	request("GET", "/setup/github/callback?code=manifest-code&state="+url.QueryEscape(manifest.State), "", 303)
	_, location := request("GET", "/api/auth/github", "", 302)
	redirect, err := url.Parse(location)
	require.NoError(t, err)
	state := redirect.Query().Get("state")
	require.NotEmpty(t, state)
	request("GET", "/api/auth/github/callback?code=owner-code&state="+url.QueryEscape(state), "", 302)
}

// Linux verifies the same served claim driver against the composed install;
// the launcher/launchd/microVM qualification remains a separate Mac check.
func TestCSEC02ClaimDriverThroughComposedInstall(t *testing.T) {
	t.Setenv("SMITHERS_CSEC02_CLAIM_DRIVER", "1")
	r := newRehearsal(t, "SMITHERS_CSEC02_CLAIM_DRIVER", "C-SEC-02", "csec02-claim-")
	var printed struct {
		URLs []string `json:"setup_urls"`
	}
	require.NoError(t, json.Unmarshal([]byte(r.stdout.String()), &printed))
	require.NotEmpty(t, printed.URLs)
	setup, err := url.Parse(printed.URLs[0])
	require.NoError(t, err)
	server, err := url.Parse(r.origin)
	require.NoError(t, err)
	isolationClaimOwner(t, r.client, server.Host, setup.Query().Get("token"), r.origin, "rehearsal-owner", true)
	var owners int
	require.NoError(t, r.pool.QueryRow(t.Context(), `SELECT count(*) FROM self_host_owners`).Scan(&owners))
	require.Equal(t, 1, owners)
}

// Only redacted counts are retained. ps environment output is inspected in
// memory and never written, because it may include the install's credentials.
func isolationChildInventory(t *testing.T, ctx context.Context, rootPID int, bundle string) {
	t.Helper()
	output, err := exec.CommandContext(ctx, "/bin/ps", "-axo", "pid,ppid,command").Output()
	require.NoError(t, err)
	type child struct{ pid, parent int }
	var rows []child
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, e1 := strconv.Atoi(fields[0])
		parent, e2 := strconv.Atoi(fields[1])
		if e1 == nil && e2 == nil {
			rows = append(rows, child{pid, parent})
		}
	}
	owned := map[int]bool{rootPID: true}
	for changed := true; changed; {
		changed = false
		for _, row := range rows {
			if owned[row.parent] && !owned[row.pid] {
				owned[row.pid] = true
				changed = true
			}
		}
	}
	require.GreaterOrEqual(t, len(owned), 3, "launcher, backend and PostgreSQL must be observed")
	expectedPath := "PATH=" + bundle + "/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	checked := 0
	for pid := range owned {
		if pid == rootPID {
			continue
		} // The launcher itself inherits hostile input.
		environment, err := exec.CommandContext(ctx, "/bin/ps", "eww", "-p", strconv.Itoa(pid), "-o", "command=").Output()
		if err != nil {
			continue
		} // Short-lived children can exit between samples.
		found := false
		match := regexp.MustCompile(`(?:^| )PATH=(.*?)(?: [A-Za-z_][A-Za-z0-9_]*=|$)`).FindStringSubmatch(string(environment))
		if len(match) == 2 {
			require.Equal(t, expectedPath, "PATH="+match[1], "child PATH must be pinned")
			found = true
		}
		require.True(t, found, "live child must expose its PATH")
		mappings, err := exec.CommandContext(ctx, "/usr/sbin/lsof", "-p", strconv.Itoa(pid), "-d", "txt", "-Fn").Output()
		if err != nil {
			continue
		}
		paths := 0
		for _, line := range strings.Split(string(mappings), "\n") {
			if !strings.HasPrefix(line, "n/") {
				continue
			}
			path := strings.TrimPrefix(line, "n")
			approved := strings.HasPrefix(path, bundle+"/")
			for _, prefix := range []string{"/System/", "/usr/lib/", "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/", "/Library/Apple/", "/private/preboot/Cryptexes/OS/", "/private/var/db/dyld/"} {
				approved = approved || strings.HasPrefix(path, prefix)
			}
			require.True(t, approved, "child executable or dylib outside bundle/OS: %s", path)
			paths++
		}
		require.Positive(t, paths, "lsof must observe executable mappings")
		checked++
	}
	require.GreaterOrEqual(t, checked, 2, "backend and PostgreSQL executable inventory is required")
}
