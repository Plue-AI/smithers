package compose

import (
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// A Flow host shares its workspace (and, in microVM mode, its guest user)
// with repository commands, so its environment must never carry a provider
// key in any topology: model seats come from the catalog's metered proxy
// with a per-binding credential (#2187). Only variable names are inspected.
func TestFlowHostsCarryNoProviderKeyInAnyTopology(t *testing.T) {
	names := []string{"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY",
		"SMITHERS_OPENAI_COMPATIBLE_BASE_URL", "SMITHERS_EVALUATOR_BASE_URL"}
	for _, name := range names {
		t.Setenv(name, "set-by-operator")
	}
	apiHelper := "/usr/local/lib/smithers/smithers-jj-export"
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", apiHelper)
	t.Setenv("SMITHERS_CODING_LOCAL_OWNER", "1")
	for _, role := range []topology{localTopology, hostedAPITopology, hostedWorkerTopology} {
		environment := codingHostEnvironment(role)
		wantHelper := services.WorkspaceJJExportGuestPath
		if environment["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] != wantHelper {
			t.Errorf("%+v coding host helper = %q, want %q", role, environment["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"], wantHelper)
		}
		for _, name := range names {
			if _, ok := environment[name]; ok {
				t.Errorf("%+v coding Flow host environment carries %s", role, name)
			}
		}
		if _, ok := environment["SMITHERS_CODING_LOCAL_OWNER"]; ok {
			t.Errorf("%+v coding host carries local owner mode", role)
		}
	}
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "")
	for _, role := range []topology{localTopology, hostedAPITopology, hostedWorkerTopology} {
		if got := codingHostEnvironment(role)["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]; got != services.WorkspaceJJExportGuestPath {
			t.Errorf("%+v coding host helper without an API path = %q, want guest path", role, got)
		}
	}
}

func TestFlowHostProductAPIURLUsesRuntimeReachableOrigin(t *testing.T) {
	cases := []struct {
		name    string
		options runOptions
		listen  string
		want    string
		fail    bool
	}{
		{name: "local listener", options: runOptions{topology: localTopology, Options: Options{}}, listen: "0.0.0.0:4000", want: "http://127.0.0.1:4000"},
		{name: "hosted explicit internal", options: runOptions{topology: hostedWorkerTopology, Options: Options{FlowHostProductAPIURL: "https://backend.internal/"}}, listen: ":4000", want: "https://backend.internal"},
		{name: "hosted no internal", options: runOptions{topology: hostedWorkerTopology, Options: Options{}}, listen: ":4000", fail: true},
		{name: "externally mounted listener", options: runOptions{topology: localTopology, Options: Options{}, externalHTTP: true}, listen: ":4000", fail: true},
		{name: "ephemeral listener", options: runOptions{topology: localTopology, Options: Options{}}, listen: ":0", fail: true},
		{name: "untrusted URL", options: runOptions{topology: hostedWorkerTopology, Options: Options{FlowHostProductAPIURL: "https://backend.internal/path"}}, listen: ":4000", fail: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := flowHostProductAPIURL(test.options, test.listen)
			if (err != nil) != test.fail || got != test.want {
				t.Fatalf("origin = %q, error = %v; want %q, fail %v", got, err, test.want, test.fail)
			}
		})
	}
}
