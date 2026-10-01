package services

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/stretchr/testify/require"
)

func TestWorkspaceArtifactBakedContentIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, body, digest string
		reused             bool
	}{
		{"exact bytes", "release payload", "", true},
		{"wrong bytes", "old release", "", false},
		{"missing", "", "", false},
		{"absent host source", "release payload", "absent", false},
		{"empty host source", "release payload", "empty", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			client := &artifactGuestClient{root: root, script: filepath.Join(root, "bootstrap.sh")}
			baked := filepath.Join(root, "baked")
			require.NoError(t, os.MkdirAll(baked, 0700))
			if tc.body != "" {
				require.NoError(t, os.WriteFile(filepath.Join(baked, "fixture.source"), []byte(tc.body), 0600))
			}
			digest := tc.digest
			if digest == "" {
				digest = fmt.Sprintf("%x", sha256.Sum256([]byte("release payload")))
			}
			reused, err := stageBakedWorkspaceArtifact(context.Background(), &bakedArtifactGuestClient{artifactGuestClient: client}, "fixture", workspaceArtifactRoot+"/attempt", workspaceArtifactSource{target: "fixture", digest: digest})
			require.NoError(t, err)
			require.Equal(t, tc.reused, reused)
			require.Zero(t, client.writeCount, "image reuse must avoid outbound payload writes")
			part := filepath.Join(root, "attempt", "fixture.part00000000")
			if !tc.reused {
				_, err := os.Stat(part)
				require.True(t, os.IsNotExist(err))
				return
			}
			raw, err := os.ReadFile(part)
			require.NoError(t, err)
			gz := base64.NewDecoder(base64.StdEncoding, strings.NewReader(string(raw)))
			reader, err := gzip.NewReader(gz)
			require.NoError(t, err)
			defer reader.Close()
			decoded, err := io.ReadAll(reader)
			require.NoError(t, err)
			require.Equal(t, "release payload", string(decoded))
		})
	}
}

func TestWorkspaceArtifactBakedCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	client := newArtifactRecordingClient()
	reused, err := stageBakedWorkspaceArtifact(ctx, client, "fixture", "/attempt", workspaceArtifactSource{target: "fixture", digest: strings.Repeat("a", 64)})
	require.ErrorIs(t, err, context.Canceled)
	require.False(t, reused)
	require.Empty(t, client.writes)
}

type bakedArtifactGuestClient struct {
	*artifactGuestClient
	compressionFails bool
}

func (c *bakedArtifactGuestClient) Execute(ctx context.Context, id string, request sandbox.ExecRequest) (sandbox.ExecResult, error) {
	request.Command = strings.ReplaceAll(request.Command, workspaceArtifactBakedRoot, filepath.Join(c.root, "baked"))
	if c.compressionFails {
		request.Command = strings.ReplaceAll(request.Command, "gzip -1c", "false")
	}
	return c.artifactGuestClient.Execute(ctx, id, request)
}

func TestWorkspaceArtifactBakedCompressionFailure(t *testing.T) {
	root := t.TempDir()
	client := &bakedArtifactGuestClient{artifactGuestClient: &artifactGuestClient{root: root, script: filepath.Join(root, "bootstrap.sh")}, compressionFails: true}
	baked := filepath.Join(root, "baked")
	require.NoError(t, os.MkdirAll(baked, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(baked, "fixture.source"), []byte("release payload"), 0600))
	reused, err := stageBakedWorkspaceArtifact(t.Context(), client, "fixture", workspaceArtifactRoot+"/attempt", workspaceArtifactSource{target: "fixture", digest: fmt.Sprintf("%x", sha256.Sum256([]byte("release payload")))})
	require.Error(t, err)
	require.False(t, reused)
	_, err = os.Stat(filepath.Join(root, "attempt", "fixture.part00000000"))
	require.True(t, os.IsNotExist(err), "a failed encoding cannot leave a publishable part")
}

func TestWorkspaceArtifactBakedExecutablePublication(t *testing.T) {
	for _, matching := range []bool{true, false} {
		t.Run(fmt.Sprint(matching), func(t *testing.T) {
			guest := artifactGuestFixture(t)
			client := &bakedArtifactGuestClient{artifactGuestClient: guest}
			baked := filepath.Join(guest.root, "baked")
			require.NoError(t, os.MkdirAll(baked, 0700))
			source := filepath.Join(guest.root, "host-source")
			payload := "#!/bin/sh\nprintf 'release-host-ok\\n'\n"
			require.NoError(t, os.WriteFile(source, []byte(payload), 0600))
			t.Setenv(workspaceCodingHostBinaryEnv, source)
			t.Setenv(workspaceCLIPackageEnv, filepath.Join(guest.root, "missing-cli"))
			body := payload
			if !matching {
				body = "old release"
			}
			require.NoError(t, os.WriteFile(filepath.Join(baked, "smithers-workspace-coding-host.b64.source"), []byte(body), 0600))
			installed := filepath.Join(guest.root, "installed-host")
			script := "#!/bin/sh\ncat '" + guest.root + "/current/smithers-workspace-coding-host.b64'.part* | base64 -d | gzip -dc > '" + installed + "'\nchmod 0755 '" + installed + "'\n'" + installed + "' > '" + guest.root + "/receipt'\n"
			require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "fixture", script))
			require.NoError(t, waitForWorkspaceArtifactBootstrap(t.Context(), client, "fixture"))
			receipt, err := os.ReadFile(filepath.Join(guest.root, "receipt"))
			require.NoError(t, err)
			require.Equal(t, "release-host-ok\n", string(receipt))
			if matching {
				require.Equal(t, 2, guest.writeCount, "only recipe and receipt cross transport")
			} else {
				require.Equal(t, 3, guest.writeCount, "wrong baked bytes fall back to checked host transfer")
			}
			writes := guest.writeCount
			require.NoError(t, finishWorkspaceArtifacts(t.Context(), client, "fixture", script))
			require.Equal(t, writes, guest.writeCount, "published bundle reuse remains idempotent")
		})
	}
}
