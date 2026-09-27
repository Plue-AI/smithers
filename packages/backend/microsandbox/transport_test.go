package microsandbox

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A managed host's program and any environment value naming a file of the
// host bundle map to the guest bundle; nothing else is rewritten.
func TestGuestArtifactPath(t *testing.T) {
	artifacts := map[string]string{"/srv/hosts": "/opt/smithers/hosts"}
	for value, want := range map[string]string{
		"/srv/hosts/smithers-coding-host":           "/opt/smithers/hosts/smithers-coding-host",
		"/srv/hosts/linux-arm64/smithers-jj-export": "/opt/smithers/hosts/linux-arm64/smithers-jj-export",
		"/srv/hosts":            "",
		"/srv/hosts-other/tool": "",
		"/srv/hosts/../secrets": "",
		"srv/hosts/relative":    "",
		"1":                     "",
		"http://127.0.0.1:4000/srv/hosts/not-a-path": "",
	} {
		got, ok := guestArtifactPath(artifacts, value)
		if ok != (want != "") || got != want {
			t.Errorf("guestArtifactPath(%q) = %q, %t; want %q", value, got, ok, want)
		}
	}
}

// Outsider-started work in a microVM honours the per-run GitHub deny by
// construction: after WithholdConversationEgress, as before it, the machine
// is created with no network but the backend's own port, where the product
// applies the withheld conversation scopes. There is no GitHub route to deny.
func TestWithheldConversationEgressLeavesOnlyTheBackendPort(t *testing.T) {
	runtime := &Runtime{config: Config{CPUs: 4, MemoryMiB: 8192, HostPorts: []uint16{64820}}, owner: "smithers-backend-0123456789abcdef", holder: "test"}
	require.NoError(t, runtime.WithholdConversationEgress(context.Background(), "outsider-lane"))
	flags := runtime.machineFlags("outsider-lane")
	var network []string
	for index, flag := range flags {
		switch {
		case flag == "--no-net":
			network = append(network, flag)
		case strings.HasPrefix(flag, "--net"), strings.HasPrefix(flag, "--port"), flag == "-p", strings.HasPrefix(flag, "--dns"), strings.HasPrefix(flag, "--allow"):
			value := ""
			if index+1 < len(flags) {
				value = flags[index+1]
			}
			network = append(network, flag+" "+value)
		}
	}
	require.Equal(t, []string{"--no-net", "--net-rule allow@host:tcp:64820"}, network)
	for _, flag := range flags {
		require.NotContains(t, strings.ToLower(flag), "github")
	}
}
