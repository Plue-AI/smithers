package workspace_scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Fake tool executables isolate version negotiation from network downloads;
// bash, tar and symlink resolution exercise the rendered production script.
func TestBootstrapReusesCompatibleNode(t *testing.T) {
	for _, tc := range []struct {
		name, version             string
		local, npmFails, download bool
	}{
		{"baked compatible", "v22.5.0", false, false, false},
		{"local compatible", "v22.1.0", true, false, false},
		{"older major", "v20.19.0", false, false, true},
		{"newer major", "v24.1.0", false, false, true},
		{"misleading version", "v22.bad.0", false, false, true},
		{"broken npm", "v22.5.0", false, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			local, baked := filepath.Join(root, ".local", "bin"), filepath.Join(root, "baked")
			payload := filepath.Join(root, "payload", "node-test", "bin")
			for _, path := range []string{local, baked, payload} {
				if err := os.MkdirAll(path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			write := func(path, body string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(body), 0755); err != nil {
					t.Fatal(err)
				}
			}
			archive := filepath.Join(root, "fixture.tar.gz")
			for _, tool := range []string{"node", "npm", "npx"} {
				body := "#!/bin/sh\necho 10.0.0\n"
				if tool == "node" {
					body = "#!/bin/sh\necho v22.9.0\n"
				}
				write(filepath.Join(payload, tool), body)
			}
			if out, err := exec.Command("tar", "-czf", archive, "-C", filepath.Join(root, "payload"), "node-test").CombinedOutput(); err != nil {
				t.Fatalf("archive: %v %s", err, out)
			}
			bin := baked
			if tc.local {
				bin = local
			}
			write(filepath.Join(bin, "node"), "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '"+tc.version+"'; else touch '"+filepath.Join(root, "downloaded")+"'; cp '"+archive+"' \"$SMITHERS_NODE_ARCHIVE\"; mkdir -p \"$SMITHERS_NODE_EXTRACT_DIR\"; fi\n")
			npm := "#!/bin/sh\necho 10.0.0\n"
			if tc.npmFails {
				npm = "#!/bin/sh\nexit 1\n"
			}
			write(filepath.Join(bin, "npm"), npm)
			write(filepath.Join(bin, "npx"), "#!/bin/sh\necho npx-ok\n")
			vars := sampleBootstrapVars()
			vars["LocalBinDir"], vars["LocalNodeDir"], vars["NodeInstallLog"] = local, filepath.Join(root, ".local", "node"), filepath.Join(root, "install.log")
			rendered := renderBootstrap(t, vars)
			start, end := strings.Index(rendered, "# Reuse the image's toolchain"), strings.Index(rendered, "# The configured coding host")
			if start < 0 || end <= start {
				t.Fatal("Node bootstrap section missing")
			}
			script := strings.NewReplacer("in /usr/local/bin /usr/bin /bin;", "in '"+baked+"';", "/var/tmp/smithers-node-release.tar.gz", filepath.Join(root, "download.tar.gz"), "/var/tmp/smithers-node-release", filepath.Join(root, "extract")).Replace(rendered[start:end])
			cmd := exec.Command("bash", "-c", "set -euo pipefail\n"+script)
			cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin")
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("bootstrap: %v %s", err, out)
			}
			_, err := os.Stat(filepath.Join(root, "downloaded"))
			if (err == nil) != tc.download {
				t.Fatalf("download=%v want=%v", err == nil, tc.download)
			}
			for _, tool := range []string{"node", "npm", "npx"} {
				out, err := exec.Command(filepath.Join(local, tool), "--version").CombinedOutput()
				if err != nil {
					t.Fatalf("%s unusable: %v %s", tool, err, out)
				}
				if tool == "node" && !strings.HasPrefix(string(out), "v22.") {
					t.Fatalf("wrong Node: %s", out)
				}
			}
		})
	}
}
