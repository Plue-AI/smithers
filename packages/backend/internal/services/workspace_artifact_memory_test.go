package services

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// #2936: splitting RPC frames must not retain the archive in the create
// request. This invariant prevents the provider's JSON encoder making another
// copy before a guest exists. Transfer correctness and peak memory are covered
// separately by the streaming/recovery tests.
func TestWorkspaceCreateRequestDoesNotMaterializeArtifacts(t *testing.T) {
	payload := make([]byte, 2<<20)
	_, err := rand.Read(payload)
	require.NoError(t, err)
	artifact := filepath.Join(t.TempDir(), "cli.tar")
	require.NoError(t, os.WriteFile(artifact, payload, 0600))
	t.Setenv(workspaceCLIPackageEnv, artifact)
	t.Setenv(workspaceCodingHostBinaryEnv, artifact)
	t.Setenv(workspaceJJExportBinaryEnv, artifact)
	for _, kind := range []string{"container", "vm"} {
		t.Run(kind, func(t *testing.T) {
			svc := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceEnvironmentImages(&stubEnvironmentImageResolver{image: nixTestImage(kind)}))
			req, err := svc.buildWorkspaceVMRequest(context.Background(), "", nil, 0, "", kind)
			require.NoError(t, err)
			encoded, err := json.Marshal(req)
			require.NoError(t, err)
			require.Less(t, len(encoded), 128<<10, "create JSON must contain bootstrap metadata, never artifact bytes")
		})
	}
}
