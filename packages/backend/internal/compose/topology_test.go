package compose

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

var (
	localTopology        = topology{}
	hostedAPITopology    = topology{multitenant: true, duties: DutiesHTTP}
	hostedWorkerTopology = topology{multitenant: true, duties: DutiesWorkers}
)

func TestTopologyResponsibilities(t *testing.T) {
	cases := []struct {
		name                   string
		topology               topology
		serve, workers, hosted bool
	}{
		{"single owner", localTopology, true, true, false},
		{"multitenant combined", topology{multitenant: true}, true, true, true},
		{"multitenant HTTP", hostedAPITopology, true, false, true},
		{"multitenant workers", hostedWorkerTopology, false, true, true},
		{"single owner workers", topology{duties: DutiesWorkers}, false, true, false},
	}
	for _, tc := range cases {
		got := tc.topology
		if got.servesHTTP() != tc.serve || got.workers() != tc.workers || got.hosted() != tc.hosted {
			t.Fatalf("%s: incorrect responsibilities %+v", tc.name, got)
		}
	}
}

// isolatedRuntime reports only its isolation class; composition must refuse a
// mismatched identity before it touches any other runtime method.
type isolatedRuntime struct {
	workspace.WorkspaceRuntime
	isolation workspace.IsolationLevel
}

func (r isolatedRuntime) Isolation() workspace.IsolationLevel { return r.isolation }

func TestCompositionDerivesTopologyFromIdentityAndRuntime(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		options    Options
		want       string
	}{
		{name: "unknown duties", mode: "selfhost", options: Options{Duties: "cron"}, want: `unsupported backend duties "cron"`},
		{name: "multitenant identity over a trusted process runtime", mode: "multitenant",
			options: Options{Workspace: isolatedRuntime{isolation: workspace.IsolationTrustedProcess}}, want: `auth.mode="multitenant" requires an isolated workspace runtime`},
		{name: "workers duty keeps the identity check", mode: "multitenant",
			options: Options{Duties: DutiesWorkers, Workspace: isolatedRuntime{isolation: workspace.IsolationTrustedProcess}}, want: `auth.mode="multitenant" requires an isolated workspace runtime`},
		{name: "unknown isolation class", mode: "selfhost",
			options: Options{Workspace: isolatedRuntime{isolation: "container"}}, want: `unsupported workspace isolation "container"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SMITHERS_AUTH_MODE", tc.mode)
			err := RunWithOptions(context.Background(), nil, io.Discard, io.Discard, tc.options)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("returned %v, want %q", err, tc.want)
			}
		})
	}
}
