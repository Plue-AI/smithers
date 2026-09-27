package compose

import (
	"strings"
	"testing"
)

func TestCodingHostEnvironmentKeepsOwnerProviderInsideLocalRuntime(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "owner-key")
	t.Setenv("AI_GATEWAY_API_KEY", "judge-key")
	t.Setenv("SMITHERS_OPENAI_COMPATIBLE_BASE_URL", "http://provider:8080")
	t.Setenv("SMITHERS_EVALUATOR_BASE_URL", "http://provider:8080/evaluate")
	t.Setenv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "/opt/smithers/bin/smithers-jj-export")
	local := codingHostEnvironment(localTopology)
	if local["OPENAI_API_KEY"] != "owner-key" || local["SMITHERS_OPENAI_COMPATIBLE_BASE_URL"] != "http://provider:8080" || local["SMITHERS_CODING_LOCAL_OWNER"] != "1" {
		t.Fatalf("local coding host lost owner model configuration: %#v", local)
	}
	hosted := codingHostEnvironment(hostedWorkerTopology)
	if _, ok := hosted["OPENAI_API_KEY"]; ok {
		t.Fatal("hosted catalog forwarded the owner's model key")
	}
	if hosted["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"] != "/opt/smithers/bin/smithers-jj-export" {
		t.Fatal("coding host lost the packaged Rust helper path")
	}
}

func TestHostedFlowHostsCarryNoOperatorModelKey(t *testing.T) {
	t.Setenv("AI_GATEWAY_API_KEY", "operator-secret-must-stay-out-of-guest")
	t.Setenv("OPENAI_API_KEY", "operator-secret-must-stay-out-of-guest")
	for _, role := range []topology{hostedAPITopology, hostedWorkerTopology} {
		for _, environment := range []map[string]string{codingHostEnvironment(role)} {
			for name, value := range environment {
				if strings.Contains(value, "operator-secret") || name == "AI_GATEWAY_API_KEY" {
					t.Fatalf("%+v Flow host environment carries %s; its model seats come from the metered proxy", role, name)
				}
			}
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
