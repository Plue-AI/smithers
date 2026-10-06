package microsandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestHypervisorEntitlement(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       bool
	}{
		{"present", `<plist><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>`, true},
		{"other entries", `<plist><dict><key>other</key><false/><key>com.apple.security.hypervisor</key><true/></dict></plist>`, true},
		{"absent", `<plist><dict/></plist>`, false},
		{"disabled", `<plist><dict><key>com.apple.security.hypervisor</key><false/></dict></plist>`, false},
		{"string", `<plist><dict><key>com.apple.security.hypervisor</key><string>true</string></dict></plist>`, false},
		{"nested", `<plist><dict><key>other</key><dict><key>com.apple.security.hypervisor</key><true/></dict></dict></plist>`, false},
		{"duplicate", `<plist><dict><key>com.apple.security.hypervisor</key><true/><key>com.apple.security.hypervisor</key><true/></dict></plist>`, false},
		{"missing value", `<plist><dict><key>com.apple.security.hypervisor</key></dict></plist>`, false},
		{"not key", `<plist><dict><string>com.apple.security.hypervisor</string><true/></dict></plist>`, false},
		{"invalid boolean", `<plist><dict><key>com.apple.security.hypervisor</key><true>false</true></dict></plist>`, false},
		{"invalid xml", `<plist>`, false},
		{"wrong root", `<other><dict><key>com.apple.security.hypervisor</key><true/></dict></other>`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasHypervisorEntitlement([]byte(tc.body)); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// Exercise the exported doctor with the real signed msb. No guest or server
// starts: stripping this entitlement must refuse before msb doctor can claim
// the host is ready. The fixture is a private host executable, never a root input.
func TestDoctorRefusesMissingHypervisorEntitlement(t *testing.T) {
	binary := os.Getenv("SMITHERS_MICROSANDBOX_BIN")
	if binary == "" || runtime.GOOS != "darwin" {
		if os.Getenv("SMITHERS_REQUIRE_MICROVM_TESTS") == "1" {
			t.Fatal("darwin and real SMITHERS_MICROSANDBOX_BIN required")
		}
		t.Skip("requires the real installed Darwin msb")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	directory := t.TempDir()
	body, err := os.ReadFile(binary)
	require.NoError(t, err)
	copy := filepath.Join(directory, "msb")
	require.NoError(t, os.WriteFile(copy, body, 0755))
	entitlements := filepath.Join(directory, "entitlements.plist")
	for _, enabled := range []bool{true, false} {
		declaration := ""
		if enabled {
			declaration = "<key>com.apple.security.hypervisor</key><true/>"
		}
		require.NoError(t, os.WriteFile(entitlements, []byte(`<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/>`+declaration+`</dict></plist>`), 0600))
		output, err := exec.CommandContext(ctx, "/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, copy).CombinedOutput()
		require.NoError(t, err, string(output))
		client, err := newCLI(copy)
		require.NoError(t, err)
		if enabled {
			require.NoError(t, client.hypervisorEntitlement(ctx))
			continue
		}
		lines := Doctor(ctx, Config{Binary: copy, Root: filepath.Join(directory, "state")})
		require.Len(t, lines, 1)
		require.Equal(t, "msb", lines[0].Name)
		require.False(t, lines[0].OK)
		require.Contains(t, lines[0].Detail, "msb lacks com.apple.security.hypervisor entitlement")
		require.False(t, strings.Contains(lines[0].Detail, "doctor failed"), "must refuse before doctor's false ready report")
	}
	output, err := exec.CommandContext(ctx, "/usr/bin/codesign", "--remove-signature", copy).CombinedOutput()
	require.NoError(t, err, string(output))
	client, err := newCLI(copy)
	require.NoError(t, err)
	require.ErrorContains(t, client.hypervisorEntitlement(ctx), "verify msb hypervisor entitlement")
	canceled, stop := context.WithCancel(ctx)
	stop()
	require.ErrorContains(t, client.hypervisorEntitlement(canceled), "context canceled")
	require.NoFileExists(t, filepath.Join(directory, "state", "owner"))
}
