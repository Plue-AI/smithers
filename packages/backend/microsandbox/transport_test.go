package microsandbox

import "testing"

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
