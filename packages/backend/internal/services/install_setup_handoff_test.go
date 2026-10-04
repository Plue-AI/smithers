package services

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestInstallSetupHandoff(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"ready", nil, 200, "{\"setup_urls\":[\"http://localhost:4000/setup?token=unit-private\"]}\n"},
		{"claimed", pkgerrors.New(pkgerrors.CodeSetupClosed, "private detail"), 401, "{\"error\":\"setup_closed\"}\n"},
		{"mint failure", errors.New("private token must not leak"), 503, "{\"error\":\"setup_mint_failed\"}\n"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			root := setupHandoffTestDirectory(t)
			require.NoError(t, os.Chmod(root, 0700))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			// Unit seam: the separate owner-authority suite proves PostgreSQL ordering;
			// this suite exercises a real Unix listener and HTTP bytes, without a minter.
			emit := func(ctx context.Context, w io.Writer) error {
				calls++
				if fixture.err != nil {
					return fixture.err
				}
				_, err := io.WriteString(w, fixture.body)
				return err
			}
			closeServer, err := StartInstallSetupHandoff(ctx, root, emit)
			require.NoError(t, err)
			defer closeServer()
			socket := filepath.Join(root, "run/host.sock")
			info, err := os.Stat(socket)
			require.NoError(t, err)
			require.Equal(t, os.FileMode(0600), info.Mode().Perm())
			require.NotZero(t, info.Mode()&os.ModeSocket)
			client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			}}}
			defer client.CloseIdleConnections()
			for _, attempt := range []struct {
				method, path string
				status       int
			}{{"POST", "/setup-urls", 405}, {"GET", "/other", 404}, {"GET", "/setup-urls", fixture.status}, {"GET", "/setup-urls", fixture.status}} {
				request, err := http.NewRequest(attempt.method, "http://localhost"+attempt.path, nil)
				require.NoError(t, err)
				response, err := client.Do(request)
				require.NoError(t, err)
				body, err := io.ReadAll(response.Body)
				require.NoError(t, err)
				require.NoError(t, response.Body.Close())
				require.Equal(t, attempt.status, response.StatusCode)
				require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
				if attempt.path == "/setup-urls" && attempt.method == "GET" {
					require.Equal(t, fixture.body, string(body))
				}
			}
			require.Equal(t, 2, calls)
			_, err = StartInstallSetupHandoff(ctx, root, emit)
			require.ErrorContains(t, err, "already serving")
			require.NoFileExists(t, filepath.Join(root, "run/setup-urls.json"))
			require.NoError(t, closeServer())
			require.NoError(t, closeServer())
			require.NoFileExists(t, socket)
		})
	}
}

func TestInstallSetupHandoffMissingEmission(t *testing.T) {
	root := setupHandoffTestDirectory(t)
	closeServer, err := StartInstallSetupHandoff(context.Background(), root, func(context.Context, io.Writer) error { return nil })
	require.NoError(t, err)
	defer closeServer()
	socket := filepath.Join(root, "run/host.sock")
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://localhost/setup-urls")
	require.NoError(t, err)
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	require.Equal(t, 503, response.StatusCode)
	require.Equal(t, "{\"error\":\"setup_mint_failed\"}\n", string(body))
}

func TestInstallSetupHandoffRefusesUnsafePaths(t *testing.T) {
	emit := func(context.Context, io.Writer) error { return nil }
	for _, kind := range []string{"authority", "state permissions", "run symlink", "regular socket", "socket symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := setupHandoffTestDirectory(t)
			require.NoError(t, os.Chmod(root, 0700))
			run := filepath.Join(root, "run")
			if kind == "authority" {
				emit = nil
			} else if kind == "state permissions" {
				require.NoError(t, os.Chmod(root, 0755))
			} else if kind == "run symlink" {
				require.NoError(t, os.Symlink(t.TempDir(), run))
			} else {
				require.NoError(t, os.Mkdir(run, 0700))
				if kind == "regular socket" {
					require.NoError(t, os.WriteFile(filepath.Join(run, "host.sock"), []byte("retained"), 0600))
				} else {
					require.NoError(t, os.Symlink(filepath.Join(root, "outside"), filepath.Join(run, "host.sock")))
				}
			}
			_, err := StartInstallSetupHandoff(context.Background(), root, emit)
			require.Error(t, err)
			emit = func(context.Context, io.Writer) error { return nil }
		})
	}
}

func TestInstallSetupHandoffRecoversDeadSocketAndCancels(t *testing.T) {
	root := setupHandoffTestDirectory(t)
	require.NoError(t, os.Chmod(root, 0700))
	require.NoError(t, os.Mkdir(filepath.Join(root, "run"), 0700))
	socket := filepath.Join(root, "run/host.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	require.NoError(t, err)
	listener.SetUnlinkOnClose(false)
	require.NoError(t, listener.Close())
	require.NoError(t, os.Chmod(socket, 0600))
	ctx, cancel := context.WithCancel(context.Background())
	closeServer, err := StartInstallSetupHandoff(ctx, root, func(context.Context, io.Writer) error { return nil })
	require.NoError(t, err)
	defer closeServer()
	cancel()
	require.Eventually(t, func() bool { _, err := os.Stat(socket); return errors.Is(err, os.ErrNotExist) }, time.Second, 10*time.Millisecond)
}

func setupHandoffTestDirectory(t *testing.T) string {
	t.Helper()
	// Darwin Unix socket names are limited to 104 bytes; testing.TempDir's
	// descriptive per-test paths exceed that limit independently of the service.
	root, err := os.MkdirTemp("/tmp", "ins08-")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, os.RemoveAll(root)) })
	return root
}

func TestInstallSetupHandoffFlushesBeforeAuthorityReturns(t *testing.T) {
	root := setupHandoffTestDirectory(t)
	release := make(chan struct{})
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closeServer, err := StartInstallSetupHandoff(ctx, root, func(ctx context.Context, w io.Writer) error {
		if _, err := io.WriteString(w, "{\"setup_urls\":[\"http://localhost:4000/setup?token=unit-ordered\"]}\n"); err != nil {
			return err
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	require.NoError(t, err)
	defer closeServer()
	socket := filepath.Join(root, "run/host.sock")
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://localhost/setup-urls")
	require.NoError(t, err)
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "{\"setup_urls\":[\"http://localhost:4000/setup?token=unit-ordered\"]}\n", line)
}
