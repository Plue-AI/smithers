package services

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstallModelTestReasonUsesProductWords(t *testing.T) {
	for _, tc := range []struct {
		result string
		err    error
		want   string
	}{
		{`{"ok":true,"latencyMs":3,"sample":"ok"}`, nil, ""},
		{`{"ok":false,"failure":{"code":"refused","status":401}}`, nil, "Key rejected"},
		{`{"ok":false,"failure":{"code":"refused","status":403}}`, nil, "Key rejected"},
		{`{"ok":false,"failure":{"code":"refused","status":402}}`, nil, "Out of credits"},
		{`{"ok":false,"failure":{"code":"refused","status":429}}`, nil, "Out of credits or rate limited"},
		{`{"ok":false,"failure":{"code":"refused","status":404}}`, nil, "Model not found"},
		{`{"ok":false,"failure":{"code":"refused","status":503}}`, nil, "Provider error; try again"},
		{`{"ok":false,"failure":{"code":"refused","status":418}}`, nil, "Refused (HTTP 418)"},
		{`{"ok":false,"failure":{"code":"timeout","deadlineMs":15000}}`, nil, "No answer in time"},
		{`{"ok":false,"failure":{"code":"unreachable"}}`, nil, "Provider unreachable"},
		{`{"ok":false,"failure":{"code":"credential_missing","credential":"OPENAI_API_KEY"}}`, nil, "Key missing"},
		{`{"ok":false,"failure":{"code":"credential_unknown","credential":"X_KEY"}}`, nil, "Key missing"},
		{`{"ok":false,"failure":{"code":"model_not_allowed"}}`, nil, "Model not allowed"},
		{`{"ok":false,"failure":{"code":"endpoint_forbidden"}}`, nil, "Address not allowed for this key"},
		{`{"ok":false,"failure":{"code":"empty_output"}}`, nil, "Empty answer"},
		{`{"ok":false,"failure":{"code":"invalid","field":"baseUrl"}}`, nil, "Model settings invalid"},
		{`{"ok":false,"failure":{"code":"host_refused"}}`, nil, "Test failed"},
		{`not json`, nil, "Could not test the key"},
		{``, errors.New("launch owner model host: refused"), "Could not test the key"},
	} {
		require.Equal(t, tc.want, installModelTestReason(json.RawMessage(tc.result), tc.err), tc.result)
	}
}

func TestInstallFastModelNamesCerebrasOriginWithoutVersionPath(t *testing.T) {
	var binding map[string]string
	require.NoError(t, json.Unmarshal([]byte(InstallFastModel), &binding))
	// The model host appends /v1/chat/completions; a /v1 base URL answers 404.
	require.Equal(t, map[string]string{"protocol": "openai-chat", "modelId": "gpt-oss-120b", "credential": "CEREBRAS_API_KEY", "baseUrl": "https://api.cerebras.ai"}, binding)
}
