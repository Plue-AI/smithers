package workspaceconformance

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/sandbox"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

// EgressUpstream is a loopback HTTP server standing in for a bound host. It
// records each Authorization header it receives and echoes it in its body.
type EgressUpstream struct {
	*httptest.Server
	mu       sync.Mutex
	received []string
}

// NewEgressUpstream starts an upstream closed with the test.
func NewEgressUpstream(t *testing.T) *EgressUpstream {
	t.Helper()
	upstream := &EgressUpstream{}
	upstream.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream.mu.Lock()
		upstream.received = append(upstream.received, r.Header.Get("Authorization"))
		upstream.mu.Unlock()
		_, _ = io.WriteString(w, "echo:"+r.Header.Get("Authorization"))
	}))
	t.Cleanup(upstream.Close)
	return upstream
}

// Received lists the Authorization headers the upstream received.
func (u *EgressUpstream) Received() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.received...)
}

// EgressHarness drives a runtime that advertises EgressSecrets. The runtime's
// relay must be allowed to dial Upstream (egressrelay.Config.Local).
type EgressHarness struct {
	Runtime  workspace.WorkspaceRuntime
	Context  func(operationID string) context.Context
	Spec     workspace.WorkspaceSpec
	Upstream *EgressUpstream
	// Fetch returns a command that sends GET url with the header
	// "Authorization: Bearer <credential>" using the proxy environment it is
	// given, and prints the response body.
	Fetch func(url, credential string) workspace.Command
}

const conformanceSecretName = "CONFORMANCE_EGRESS_TOKEN"

// RunEgressSecrets verifies the egress secret channel: a bound command sends
// only the placeholder, the bound host receives the value, the command sees
// it masked, and rebind, revoke and stop each end the previous binding.
func RunEgressSecrets(t *testing.T, harness EgressHarness) {
	t.Helper()
	if !harness.Runtime.Capabilities().EgressSecrets {
		t.Fatalf("%T: Capabilities().EgressSecrets = false", harness.Runtime)
	}
	if _, err := harness.Runtime.CreateWorkspace(harness.Context("egress-create"), harness.Spec); err != nil {
		t.Fatalf("%T: CreateWorkspace: %v", harness.Runtime, err)
	}
	defer func() { _ = harness.Runtime.DeleteWorkspace(harness.Context("egress-cleanup"), harness.Spec.ID) }()
	secret := func(value string) []sandbox.EgressProxySecret {
		host := mustHostname(t, harness.Upstream.URL)
		return []sandbox.EgressProxySecret{{Name: conformanceSecretName, Value: value, Hosts: []string{host}, MatchHeaders: []string{"Authorization"}}}
	}
	first := randomValue(t)
	if created, err := harness.Runtime.InspectWorkspace(harness.Context("egress-inspect"), harness.Spec.ID); err == nil && created.State == workspace.WorkspaceStopped {
		if _, err := workspace.BindEgressSecrets(harness.Context("egress-bind-stopped"), harness.Runtime, harness.Spec.ID, secret(first)); !errors.Is(err, workspace.ErrWorkspaceStopped) {
			t.Fatalf("%T: BindEgressSecrets on a stopped workspace = %v; want ErrWorkspaceStopped", harness.Runtime, err)
		}
	}
	if _, err := harness.Runtime.StartWorkspace(harness.Context("egress-start"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: StartWorkspace: %v", harness.Runtime, err)
	}
	fetch := func(operation string, binding workspace.EgressSecretBinding) workspace.CommandResult {
		t.Helper()
		command := harness.Fetch(harness.Upstream.URL+"/egress", sandbox.EgressProxyPlaceholder(conformanceSecretName))
		environment := map[string]string{}
		for name, value := range command.Environment {
			environment[name] = value
		}
		for name, value := range binding.Environment {
			environment[name] = value
		}
		command.Environment = environment
		result, err := harness.Runtime.ExecuteCommand(harness.Context(operation), harness.Spec.ID, command)
		if err != nil {
			t.Fatalf("%T: %s: %v", harness.Runtime, operation, err)
		}
		return result
	}

	binding, err := workspace.BindEgressSecrets(harness.Context("egress-bind"), harness.Runtime, harness.Spec.ID, secret(first))
	if err != nil {
		t.Fatalf("%T: BindEgressSecrets: %v", harness.Runtime, err)
	}
	for name, value := range binding.Environment {
		if strings.Contains(value, first) {
			t.Fatalf("%T: binding environment %s carries the secret value", harness.Runtime, name)
		}
	}
	result := fetch("egress-fetch", binding)
	if result.ExitCode != 0 || result.Stdout != "echo:Bearer "+conformanceSecretName {
		t.Fatalf("%T: bound fetch = %#v; want the masked echo", harness.Runtime, result)
	}
	if strings.Contains(result.Stdout+result.Stderr, first) {
		t.Fatalf("%T: the command saw the secret value", harness.Runtime)
	}
	if got := harness.Upstream.Received(); len(got) != 1 || got[0] != "Bearer "+first {
		t.Fatalf("%T: upstream received %q; want the substituted value", harness.Runtime, got)
	}

	// Rebinding replaces the value and ends the old credential.
	second := randomValue(t)
	rebound, err := workspace.BindEgressSecrets(harness.Context("egress-rebind"), harness.Runtime, harness.Spec.ID, secret(second))
	if err != nil {
		t.Fatalf("%T: rebind: %v", harness.Runtime, err)
	}
	fetch("egress-fetch-stale", binding)
	fetch("egress-fetch-rebound", rebound)
	if got := harness.Upstream.Received(); len(got) != 2 || got[1] != "Bearer "+second {
		t.Fatalf("%T: after rebind upstream received %q; want only the new value", harness.Runtime, got)
	}

	// Revoking, then stopping, ends the binding.
	channel := harness.Runtime.(workspace.WorkspaceEgressSecrets)
	if err := channel.RevokeEgressSecrets(harness.Context("egress-revoke"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: RevokeEgressSecrets: %v", harness.Runtime, err)
	}
	fetch("egress-fetch-revoked", rebound)
	third, err := workspace.BindEgressSecrets(harness.Context("egress-bind-again"), harness.Runtime, harness.Spec.ID, secret(randomValue(t)))
	if err != nil {
		t.Fatalf("%T: bind after revoke: %v", harness.Runtime, err)
	}
	if err := harness.Runtime.StopWorkspace(harness.Context("egress-stop"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: StopWorkspace: %v", harness.Runtime, err)
	}
	if _, err := harness.Runtime.StartWorkspace(harness.Context("egress-restart"), harness.Spec.ID); err != nil {
		t.Fatalf("%T: StartWorkspace: %v", harness.Runtime, err)
	}
	fetch("egress-fetch-after-stop", third)
	if got := harness.Upstream.Received(); len(got) != 2 {
		t.Fatalf("%T: a stale, revoked or stopped binding reached the upstream: %q", harness.Runtime, got)
	}
}

// RunEgressSecretsRefused verifies that a runtime without the channel
// refuses bound secrets instead of accepting them some other way.
func RunEgressSecretsRefused(t *testing.T, runtime workspace.WorkspaceRuntime, ctx context.Context, workspaceID string) {
	t.Helper()
	if runtime.Capabilities().EgressSecrets {
		t.Fatalf("%T: Capabilities().EgressSecrets = true", runtime)
	}
	_, err := workspace.BindEgressSecrets(ctx, runtime, workspaceID, []sandbox.EgressProxySecret{{
		Name: conformanceSecretName, Value: "refused", Hosts: []string{"api.example.com"}, MatchHeaders: []string{"Authorization"},
	}})
	if !errors.Is(err, workspace.ErrEgressSecretsUnsupported) {
		t.Fatalf("%T: BindEgressSecrets = %v; want ErrEgressSecretsUnsupported", runtime, err)
	}
}

func mustHostname(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.Hostname()
}

func randomValue(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return "value-" + hex.EncodeToString(raw)
}
