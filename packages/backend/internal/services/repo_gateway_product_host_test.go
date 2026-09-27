package services

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRepoGatewayProductHost_StagesExactReleaseBytes(t *testing.T) {
	vm := &fakeRepoGatewayVMClient{}
	svc := newTestRepoGatewayService(&fakeRepoGatewayQuerier{}, vm)
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.NoError(t, err)
	require.Len(t, vm.createVMReqs, 1)
	encoded := vm.createVMReqs[0].Files[repoGatewayProductHostB64Path].Content
	compressed, err := base64.StdEncoding.DecodeString(encoded)
	require.NoError(t, err)
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	require.NoError(t, err)
	defer reader.Close()
	actual, err := io.ReadAll(reader)
	require.NoError(t, err)
	expected, err := os.ReadFile(svc.productHostPath)
	require.NoError(t, err)
	require.Equal(t, expected, actual)
	require.Len(t, vm.systemdSpecs, 1)
	command := strings.Join(vm.systemdSpecs[0].Exec, " ")
	require.Contains(t, command, repoGatewayProductHostPath+" serve")
	require.Contains(t, command, "--listen")
	require.NotContains(t, command, "bun x")
	require.NotContains(t, command, "--backend")
	require.Equal(t, "alice/demo", vm.systemdSpecs[0].Env["SMITHERS_REPO"])
}

func TestRepoGatewayProductHost_MissingArtifactFailsBeforeCreatingVM(t *testing.T) {
	vm := &fakeRepoGatewayVMClient{}
	q := &fakeRepoGatewayQuerier{}
	svc := newTestRepoGatewayService(q, vm)
	svc.productHostPath = t.TempDir() + "/missing.mjs"
	_, err := svc.GetRepoGatewayConnectionInfo(context.Background(), testRepoGatewayInput())
	require.ErrorContains(t, err, "product gateway artifact is missing")
	require.Empty(t, vm.createVMReqs)
	require.Equal(t, "failed", q.statusUpdates[len(q.statusUpdates)-1].Status)
}
