package services

import (
	"encoding/json"
	"github.com/stretchr/testify/require"
	"os"
	"testing"
)

func setupFixtureInput(t *testing.T) SetupInput {
	t.Helper()
	raw, err := os.ReadFile("../../../rpc/testdata/repository-setup-backend.json")
	require.NoError(t, err)
	var fixtures []SetupInput
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	return fixtures[0]
}
func TestRepositorySetupSharedCandidateContract(t *testing.T) {
	raw, err := os.ReadFile("../../../rpc/testdata/repository-setup-backend.json")
	require.NoError(t, err)
	var fixtures []SetupInput
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.Len(t, fixtures, 2)
	for _, input := range fixtures {
		require.NoError(t, ValidateSetupInput(&input))
		require.Equal(t, input.Digest, setupCandidateDigest(input, false))
	}
}
func TestRepositorySetupRejectsChangedAndInvalidInput(t *testing.T) {
	for name, edit := range map[string]func(*SetupInput){"changed draft": func(v *SetupInput) { v.Draft.Label = "changed" }, "duplicate step": func(v *SetupInput) {
		v.Draft.Steps = append(v.Draft.Steps, v.Draft.Steps[0])
		v.Digest = setupCandidateDigest(*v, false)
	}, "manual on inspect": func(v *SetupInput) { v.Manual = &SetupManual{StepID: "x"} }, "missing manual": func(v *SetupInput) { v.Operation = "run" }, "invalid workspace": func(v *SetupInput) { v.WorkspaceID = "other" }, "missing required boolean": func(v *SetupInput) { v.Draft.ConnectIssues = nil; v.Digest = setupCandidateDigest(*v, false) }} {
		t.Run(name, func(t *testing.T) {
			input := setupFixtureInput(t)
			edit(&input)
			require.Error(t, ValidateSetupInput(&input))
		})
	}
}
func TestRepositorySetupResultRequiresExactRuntimeIdentity(t *testing.T) {
	input := setupFixtureInput(t)
	response := setupInitial(input)
	response.Receipt.Phase = "completed"
	response.Receipt.RunID = "run-1"
	response.WorkspaceID = "11111111-1111-4111-8111-111111111111"
	raw, _ := json.Marshal(response)
	_, err := validateSetupOutput(input, response.WorkspaceID, "run-1", string(raw))
	require.NoError(t, err)
	for name, edit := range map[string]func(*SetupResponse){"request": func(v *SetupResponse) { v.RequestID = "other" }, "revision": func(v *SetupResponse) { v.Revision++ }, "digest": func(v *SetupResponse) { v.Digest = "wrong" }, "workspace": func(v *SetupResponse) { v.WorkspaceID = "22222222-2222-4222-8222-222222222222" }, "run": func(v *SetupResponse) { v.Receipt.RunID = "other" }, "nonterminal": func(v *SetupResponse) { v.Receipt.Phase = "running" }, "no evidence": func(v *SetupResponse) { v.Receipt = nil }} {
		t.Run(name, func(t *testing.T) {
			var value SetupResponse
			require.NoError(t, json.Unmarshal(raw, &value))
			edit(&value)
			encoded, _ := json.Marshal(value)
			_, err := validateSetupOutput(input, response.WorkspaceID, "run-1", string(encoded))
			require.Error(t, err)
		})
	}
}
