package services

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInstallSetupLiteralBodyContracts(t *testing.T) {
	for _, test := range []struct {
		step, body string
		valid      bool
	}{
		{"address", `{"bind":"127.0.0.1:4000","origins":["http://localhost:4000"]}`, true},
		{"address", `{"bind":"0.0.0.0:4000","origins":["http://factory:4000"]}`, true},
		{"address", `{"bind":"bad","origins":["http://factory"]}`, false},
		{"address", `{"bind":"127.0.0.1:4000","origins":["http://factory","https://factory"]}`, false},
		{"address", `{"bind":"127.0.0.1:4000","origins":["http://user:pass@factory"]}`, false},
		{"address", `{"bind":"127.0.0.1:4000","origins":["http://factory/path"]}`, false},
		{"address", `{"bind":"127.0.0.1:4000","origins":[]}`, false},
		{"address", `{"bind":"127.0.0.1:4000"}`, false},
		{"address", `{"bind":3,"origins":[]}`, false},
		{"app_manifest", `{"owner":"smithersai"}`, true},
		{"app_manifest", `{"owner":"../evil"}`, false},
		{"app_manifest", `{"owner":"smithersai","owner_kind":"org"}`, false},
		{"app_manifest", `{}`, false},
		{"app_manifest", `{"owner":null}`, false},
		{"repository", `{"repository":"smithersai/smithers"}`, true},
		{"repository", `{"repository":"smithersai/smithers","installation_id":123}`, false},
		{"repository", `{"repository":"smithersai/smithers/other"}`, false},
		{"repository", `{"repository":true}`, false},
		{"models", `{}`, true},
		{"models", `{"key":"secret"}`, false},
		{"models", `null`, false},
		{"models", `[]`, false},
		{"models", `{} {}`, false},
		{"github_app", `{}`, false},
		{"source", `{}`, true},
		{"machine", `{}`, true},
	} {
		t.Run(test.step+test.body, func(t *testing.T) {
			_, err := ValidateInstallSetupBody(test.step, []byte(test.body))
			require.Equal(t, test.valid, err == nil)
		})
	}
}
func TestInstallSetupTransitionLeaseBoundaries(t *testing.T) {
	now := time.Unix(1000, 0)
	for _, test := range []struct {
		state   InstallStepState
		expiry  time.Time
		allowed bool
	}{
		{InstallPending, time.Time{}, true}, {InstallFailed, time.Time{}, true}, {"blocked", time.Time{}, true},
		{InstallReady, time.Time{}, false}, {InstallRunning, now.Add(time.Second), false},
		{InstallRunning, now, true}, {InstallRunning, now.Add(-time.Second), true}, {InstallRunning, time.Time{}, false},
		{"unknown", now, false},
	} {
		require.Equal(t, test.allowed, installStepCanStart(InstallStep{Status: test.state, ExpiresAt: test.expiry}, now))
	}
	require.Equal(t, -1, installStepIndex("app"))
	require.Equal(t, 1, installStepIndex("app_manifest"))
}
func TestInstallSetupErrorRoundTrip(t *testing.T) {
	raw := []byte(`{"id":"machine","status":"failed","error":{"code":"recipe_invalid","class":"user","message":"Fix recipe","fix":".smithers/machine.json"}}`)
	var step InstallStep
	require.NoError(t, json.Unmarshal(raw, &step))
	require.Equal(t, "recipe_invalid", step.Error.Code)
	require.Equal(t, "user", step.Error.Class)
	require.Equal(t, "Fix recipe", step.Error.Message)
	require.Equal(t, ".smithers/machine.json", step.Error.Fix)
	encoded, err := json.Marshal(step)
	require.NoError(t, err)
	var roundtrip InstallStep
	require.NoError(t, json.Unmarshal(encoded, &roundtrip))
	require.Equal(t, step.Error, roundtrip.Error)
}
