package workspace_scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapReplacesIncompatibleJJ(t *testing.T) {
	for _, tc := range []struct {
		name, initial   string
		download, fails bool
	}{
		{"newer base image", "0.44.0-base", true, false},
		{"older base image", "0.38.0", true, false},
		{"compatible exact", "0.39.0", false, false},
		{"compatible build", "0.39.0-build", false, false},
		{"download failure", "0.44.0", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			extract := filepath.Join(dir, "release")
			if err := os.MkdirAll(bin, 0755); err != nil {
				t.Fatal(err)
			}
			write := func(path, body string) {
				t.Helper()
				if err := os.WriteFile(path, []byte(body), 0755); err != nil {
					t.Fatal(err)
				}
			}
			write(filepath.Join(bin, "jj"), "#!/bin/sh\necho 'jj "+tc.initial+"'\n")
			fixture := filepath.Join(dir, "payload")
			if err := os.Mkdir(fixture, 0755); err != nil {
				t.Fatal(err)
			}
			write(filepath.Join(fixture, "jj"), "#!/bin/sh\necho 'jj 0.39.0'\n")
			archive := filepath.Join(dir, "fixture.tar.gz")
			if out, err := exec.Command("tar", "-czf", archive, "-C", fixture, "jj").CombinedOutput(); err != nil {
				t.Fatalf("archive: %v %s", err, out)
			}
			node := "#!/bin/sh\ntouch '" + filepath.Join(dir, "downloaded") + "'\n"
			if tc.fails {
				node += "exit 1\n"
			} else {
				node += "cp '" + archive + "' \"$SMITHERS_JJ_ARCHIVE\"\n"
			}
			write(filepath.Join(bin, "node"), node)
			rendered := renderBootstrap(t, sampleBootstrapVars())
			start := strings.Index(rendered, "smithers_jj_compatible()")
			if start < 0 {
				t.Fatal("JJ bootstrap section missing")
			}
			end := strings.Index(rendered[start:], "# Reuse the image's toolchain") + start
			if start < 0 || end < start {
				t.Fatal("JJ bootstrap section missing")
			}
			script := strings.NewReplacer("/var/tmp/smithers-jj-release.tar.gz", filepath.Join(dir, "download.tar.gz"), "/var/tmp/smithers-jj-release", extract, "/usr/local/bin/jj", filepath.Join(bin, "jj"), "/tmp/smithers-workspace-jj-bootstrap.log", filepath.Join(dir, "download.log")).Replace(rendered[start:end])
			cmd := exec.Command("bash", "-c", "set -euo pipefail\n"+script)
			cmd.Env = append(os.Environ(), "PATH="+bin+":/usr/bin:/bin")
			out, err := cmd.CombinedOutput()
			if (err != nil) != tc.fails {
				t.Fatalf("bootstrap failure=%v want=%v: %s", err, tc.fails, out)
			}
			_, downloadErr := os.Stat(filepath.Join(dir, "downloaded"))
			if (downloadErr == nil) != tc.download {
				t.Fatalf("download=%v want=%v", downloadErr == nil, tc.download)
			}
			if !tc.fails {
				version, err := exec.Command(filepath.Join(bin, "jj"), "--version").Output()
				if err != nil || !strings.HasPrefix(string(version), "jj 0.39.0") {
					t.Fatalf("unusable pin: %s %v", version, err)
				}
			}
		})
	}
}
