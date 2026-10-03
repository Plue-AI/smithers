package microsandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// This CLI protocol fixture executes real child processes without booting a VM.
// Real image import/boot evidence belongs to the server bundle integration gate.
func bundledImageFixture(t *testing.T, loadBody string) (Config, string, string) {
	t.Helper()
	prefix := t.TempDir()
	binary := filepath.Join(prefix, "bin", "msb")
	bundle := filepath.Join(prefix, "share", "microsandbox")
	log := filepath.Join(prefix, "commands")
	require.NoError(t, os.MkdirAll(filepath.Dir(binary), 0o700))
	require.NoError(t, os.MkdirAll(bundle, 0o700))
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> %q
case "$1" in
image) %s ;;
list) printf '[]' ;;
esac
`, log, loadBody)
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o700))
	data := []byte("test image archive")
	checksum := sha256.Sum256(data)
	manifest, err := json.Marshal(map[string]string{"image": DefaultImage, "archive": "base-image.oci.tar", "sha256": hex.EncodeToString(checksum[:])})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.json"), manifest, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.oci.tar"), data, 0o600))
	return Config{Binary: binary, Root: filepath.Join(prefix, "state"), CPUs: 2, MemoryMiB: 6144, DiskMiB: 32768, MaxRunningVMs: 1, SkipQualification: true}, bundle, log
}

func readImageCommands(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ""
	}
	require.NoError(t, err)
	return string(content)
}

func TestBundledImageLoadsBeforeRuntimeRecovery(t *testing.T) {
	config, bundle, log := bundledImageFixture(t, "exit 0")
	runtime, err := New(t.Context(), config)
	require.NoError(t, err)
	require.NotNil(t, runtime)
	commands := strings.Split(strings.TrimSpace(readImageCommands(t, log)), "\n")
	require.GreaterOrEqual(t, len(commands), 2)
	require.Equal(t, "image load --input "+filepath.Join(bundle, "base-image.oci.tar")+" --tag "+DefaultImage, commands[0])
	require.True(t, strings.HasPrefix(commands[1], "list "), commands)
}

func TestBundledImageRefusesInvalidBundlesBeforeLaunchingCLI(t *testing.T) {
	for _, test := range []struct {
		name, message string
		mutate        func(*testing.T, Config, string)
	}{
		{"missing archive", "archive", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.Remove(filepath.Join(bundle, "base-image.oci.tar")))
		}},
		{"missing manifest", "manifest", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.Remove(filepath.Join(bundle, "base-image.json")))
		}},
		{"corrupt manifest", "manifest", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.json"), []byte("{"), 0o600))
		}},
		{"checksum mismatch", "checksum", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.oci.tar"), []byte("modified"), 0o600))
		}},
		{"unpinned image", "image", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.json"), []byte(`{"image":"node:latest","archive":"base-image.oci.tar","sha256":"`+strings.Repeat("0", 64)+`"}`), 0o600))
		}},
		{"archive escape", "archive", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.json"), []byte(`{"image":"`+DefaultImage+`","archive":"../escape.tar","sha256":"`+strings.Repeat("0", 64)+`"}`), 0o600))
		}},
		{"invalid checksum", "checksum", func(t *testing.T, _ Config, bundle string) {
			require.NoError(t, os.WriteFile(filepath.Join(bundle, "base-image.json"), []byte(`{"image":"`+DefaultImage+`","archive":"base-image.oci.tar","sha256":"bad"}`), 0o600))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, bundle, log := bundledImageFixture(t, "exit 0")
			test.mutate(t, config, bundle)
			runtime, err := New(t.Context(), config)
			require.Error(t, err)
			require.ErrorIs(t, err, ErrUnavailable)
			require.ErrorContains(t, err, test.message)
			require.Nil(t, runtime)
			require.Empty(t, readImageCommands(t, log))
		})
	}
}

func TestBundledImageRefusesConfiguredImageMismatch(t *testing.T) {
	config, _, log := bundledImageFixture(t, "exit 0")
	config.Image = "custom@sha256:" + strings.Repeat("a", 64)
	runtime, err := New(t.Context(), config)
	require.ErrorContains(t, err, "image")
	require.Nil(t, runtime)
	require.Empty(t, readImageCommands(t, log))
}

func TestBundledImageLoadFailureDoesNotRecoverOrCreateMachines(t *testing.T) {
	config, _, log := bundledImageFixture(t, "printf 'invalid archive' >&2; exit 17")
	runtime, err := New(t.Context(), config)
	require.ErrorIs(t, err, ErrUnavailable)
	require.ErrorContains(t, err, "invalid archive")
	require.Nil(t, runtime)
	require.Equal(t, 1, strings.Count(readImageCommands(t, log), "\n"))
}

func TestBundledImageLoadCancellationKillsProcess(t *testing.T) {
	config, _, log := bundledImageFixture(t, "while :; do sleep 1; done")
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	runtime, err := New(ctx, config)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Nil(t, runtime)
	require.Less(t, time.Since(started), 2*time.Second)
	require.NotContains(t, readImageCommands(t, log), "list ")
}

func TestSourceDevelopmentWithoutBundledImageStillStarts(t *testing.T) {
	config, bundle, log := bundledImageFixture(t, "exit 0")
	require.NoError(t, os.RemoveAll(bundle))
	runtime, err := New(t.Context(), config)
	require.NoError(t, err)
	require.NotNil(t, runtime)
	require.NotContains(t, readImageCommands(t, log), "image load")
}

func TestBundledImageWorkspaceAndPrepareCreationNeverPull(t *testing.T) {
	for _, kind := range []string{"workspace", "prepare"} {
		t.Run(kind, func(t *testing.T) {
			config, _, log := bundledImageFixture(t, "exit 0")
			// Stop after the CLI creation boundary: this fixture has no real guest.
			binary, err := os.ReadFile(config.Binary)
			require.NoError(t, err)
			binary = []byte(strings.Replace(string(binary), "list) printf '[]' ;;", "list) printf '[]' ;;\nexec) exit 19 ;;", 1))
			require.NoError(t, os.WriteFile(config.Binary, binary, 0o700))
			runtime, err := New(t.Context(), config)
			require.NoError(t, err)
			if kind == "workspace" {
				err = runtime.createMachine(t.Context(), newWorkspace(metadata{ID: "test", Machine: "test"}, ""))
			} else {
				layerConfig := EnvironmentConfig{PrepareCPUs: 2, PrepareMemoryMiB: 6144, PrepareDiskMiB: 32768}
				layerConfig.defaults()
				layers := &environments{runtime: runtime, config: layerConfig}
				_, err = layers.buildLayer(t.Context(), layerRecord{}, toolchainLayer{}, "", nil)
			}
			require.Error(t, err, "fixture deliberately refuses guest commands")
			commands := readImageCommands(t, log)
			require.Equal(t, 1, strings.Count(commands, "image load "))
			require.Contains(t, commands, "create "+DefaultImage+" --pull never --root-disk ")
			require.NotContains(t, commands, "--pull if-missing")
			require.Less(t, strings.Index(commands, "image load "), strings.Index(commands, "create "))
		})
	}
}

func TestBundledImageConcurrentCreationLoadsOnceAndRetainsMachineFlags(t *testing.T) {
	config, _, log := bundledImageFixture(t, "sleep 0.05; exit 0")
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	results := make(chan error, 12)
	for i := 0; i < cap(results); i++ {
		go func() {
			args, err := client.imageCreateArgs(t.Context(), DefaultImage, 128, []string{"--no-net", "-n", "machine with spaces"})
			if err == nil && strings.Join(args, "|") != "create|"+DefaultImage+"|--pull|never|--root-disk|128M|--no-net|-n|machine with spaces" {
				err = fmt.Errorf("unexpected machine arguments: %q", args)
			}
			results <- err
		}()
	}
	for i := 0; i < cap(results); i++ {
		require.NoError(t, <-results)
	}
	require.Equal(t, 1, strings.Count(readImageCommands(t, log), "image load "))
	// Successful import cannot satisfy a differently configured image.
	_, err = client.imageCreateArgs(t.Context(), "other@sha256:"+strings.Repeat("a", 64), 128, nil)
	require.ErrorContains(t, err, "does not match")
	require.Equal(t, 1, strings.Count(readImageCommands(t, log), "image load "))
}

func TestBundledImageFailedImportIsRetryable(t *testing.T) {
	config, _, log := bundledImageFixture(t, "exit 17")
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	_, err = client.imageCreateArgs(t.Context(), DefaultImage, 128, nil)
	require.Error(t, err)
	binary, err := os.ReadFile(config.Binary)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(config.Binary, []byte(strings.Replace(string(binary), "exit 17", "exit 0", 1)), 0o700))
	args, err := client.imageCreateArgs(t.Context(), DefaultImage, 128, nil)
	require.NoError(t, err)
	require.Contains(t, args, "never")
	require.Equal(t, 2, strings.Count(readImageCommands(t, log), "image load "))
}

func TestBundledImageCancelledWaiterDoesNotBlockOnAnotherImport(t *testing.T) {
	config, _, log := bundledImageFixture(t, "while :; do sleep 1; done")
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := client.imagePullPolicy(ctx, DefaultImage); done <- err }()
	require.Eventually(t, func() bool { return strings.Contains(readImageCommands(t, log), "image load ") }, 2*time.Second, 10*time.Millisecond)
	waiting, stopWaiting := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer stopWaiting()
	start := time.Now()
	_, err = client.imagePullPolicy(waiting, DefaultImage)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Less(t, time.Since(start), time.Second)
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)
	require.Equal(t, 1, strings.Count(readImageCommands(t, log), "image load "))
}

func TestSourceDevelopmentCreationRetainsConfiguredImageAndPullPolicy(t *testing.T) {
	config, bundle, log := bundledImageFixture(t, "exit 0")
	require.NoError(t, os.RemoveAll(bundle))
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	args, err := client.imageCreateArgs(t.Context(), "development:latest", 256, []string{"--no-net"})
	require.NoError(t, err)
	require.Equal(t, []string{"create", "development:latest", "--pull", "if-missing", "--root-disk", "256M", "--no-net"}, args)
	require.Empty(t, readImageCommands(t, log))
}

func TestBundledImageHashReaderHonoursCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	reader := contextImageReader{ctx: ctx, reader: strings.NewReader("data")}
	count, err := reader.Read(make([]byte, 32))
	require.Zero(t, count)
	require.ErrorIs(t, err, context.Canceled)
}

func TestBundledImageRejectsUnreadableDirectoryAndNonRegularArchive(t *testing.T) {
	for _, kind := range []string{"directory symlink loop", "archive directory"} {
		t.Run(kind, func(t *testing.T) {
			config, bundle, log := bundledImageFixture(t, "exit 0")
			if kind == "directory symlink loop" {
				require.NoError(t, os.RemoveAll(bundle))
				require.NoError(t, os.Symlink(bundle, bundle))
			} else {
				archive := filepath.Join(bundle, "base-image.oci.tar")
				require.NoError(t, os.Remove(archive))
				require.NoError(t, os.Mkdir(archive, 0o700))
			}
			client, err := newCLI(config.Binary)
			require.NoError(t, err)
			_, err = client.imagePullPolicy(t.Context(), DefaultImage)
			require.ErrorIs(t, err, ErrUnavailable)
			require.Empty(t, readImageCommands(t, log))
		})
	}
}

func TestBundledImageCancellationDuringArchiveHashStartsNoProcess(t *testing.T) {
	config, bundle, log := bundledImageFixture(t, "exit 0")
	archive, err := os.OpenFile(filepath.Join(bundle, "base-image.oci.tar"), os.O_WRONLY, 0)
	require.NoError(t, err)
	// Sparse file makes checksum work long enough to cancel without writing data.
	require.NoError(t, archive.Truncate(256<<20))
	require.NoError(t, archive.Close())
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	_, err = client.imagePullPolicy(ctx, DefaultImage)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.ErrorContains(t, err, "checksum")
	require.Empty(t, readImageCommands(t, log))
}

func TestBundledImagePreCancelledCallDoesNotImport(t *testing.T) {
	config, _, log := bundledImageFixture(t, "exit 0")
	client, err := newCLI(config.Binary)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	for i := 0; i < 20; i++ {
		_, err := client.imagePullPolicy(ctx, DefaultImage)
		require.ErrorIs(t, err, context.Canceled)
	}
	require.Empty(t, readImageCommands(t, log))
}
