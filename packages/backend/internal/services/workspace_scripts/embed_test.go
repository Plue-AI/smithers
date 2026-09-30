package workspace_scripts

import (
	"strings"
	"testing"
	"text/template"
)

// sampleBootstrapVars mirrors the bootstrapVars struct in
// internal/services/workspace_provisioning.go — every field referenced by
// bootstrap.sh.tmpl must have a key here or the missingkey=error render test
// fails, catching template/struct drift.
func sampleBootstrapVars() map[string]string {
	return map[string]string{
		"User":                "dev",
		"Home":                "/home/dev",
		"LocalDir":            "/home/dev/.local",
		"LocalBinDir":         "/home/dev/.local/bin",
		"LocalNodeDir":        "/home/dev/.local/node",
		"JJReleaseAPIURL":     "https://api.github.com/repos/jj-vcs/jj/releases/latest",
		"NodeDistIndexURL":    "https://nodejs.org/dist/index.json",
		"NodeMajor":           "22",
		"NodeInstallLog":      "/tmp/node-install.log",
		"ClaudeInstallScript": "npm install -g claude",
		"DownloadScript":      "ZG93bmxvYWQ=",
		"CodingHostPath":      "/usr/local/bin/smithers-coding-host",
		"CodingHostB64Path":   "/opt/smithers-coding-host.b64",
		"JJExportPath":        "/usr/local/bin/smithers-jj-export",
		"JJExportB64Path":     "/opt/smithers-jj-export.b64",
		"BunVersion":          "1.3.9",
		"CLIPackageB64Path":   "/opt/cli-package.b64",
		"CLIPackageDir":       "/usr/local/lib/smithers-cli",
	}
}

func renderBootstrap(t *testing.T, vars map[string]string) string {
	t.Helper()
	tmpl, err := template.New("bootstrap").Option("missingkey=error").Parse(BootstrapTemplate)
	if err != nil {
		t.Fatalf("parse bootstrap template: %v", err)
	}
	var sb strings.Builder
	if err := tmpl.Execute(&sb, vars); err != nil {
		t.Fatalf("execute bootstrap template: %v", err)
	}
	return sb.String()
}

func TestBootstrapTemplateRenders(t *testing.T) {
	out := renderBootstrap(t, sampleBootstrapVars())

	tests := []struct {
		name string
		want string
	}{
		{"shebang first line", "#!/bin/bash"},
		{"strict mode", "set -euo pipefail"},
		{"smithers state dir", "install -d -o dev -g dev -m 700 /home/dev/.smithers"},
		{"jj release url exported", `export SMITHERS_JJ_RELEASE_API_URL="https://api.github.com/repos/jj-vcs/jj/releases/latest"`},
		{"jj release scratch uses writable disk", `export SMITHERS_JJ_ARCHIVE="/var/tmp/smithers-jj-release.tar.gz"`},
		{"node index url exported", `export SMITHERS_NODE_INDEX_URL="https://nodejs.org/dist/index.json"`},
		{"node major exported", `export SMITHERS_NODE_MAJOR="22"`},
		{"node release scratch uses writable disk", `export SMITHERS_NODE_ARCHIVE="/var/tmp/smithers-node-release.tar.gz"`},
		{"node links require complete extraction", `[ -x "$node_dir/bin/node" ] && [ -x "$node_dir/bin/npm" ]`},
		{"download script payload", `"ZG93bmxvYWQ="`},
		{"claude install via runuser", `runuser -u dev -- env -i HOME=/home/dev`},
		{"ownership fix", "chown -R dev:dev /home/dev/.local /home/dev/.smithers"},
		{"bun guarded install", "if ! command -v bun >/dev/null 2>&1; then"},
		{"bun pinned npm install", "npm install -g --prefix /usr/local bun@1.3.9 >/tmp/smithers-workspace-bun-install.log 2>&1"},
		{"bun install best-effort", "smithers workspace bootstrap: bun install failed; continuing without bun"},
		{"jj export first chunk guard", `if [ -s "/opt/smithers-jj-export.b64".part00000000 ]; then`},
		{"jj export payload decode", `cat "/opt/smithers-jj-export.b64".part* | base64 -d | gzip -dc > "/usr/local/bin/smithers-jj-export".tmp`},
		{"jj export installed 0755", `install -m 0755 "/usr/local/bin/smithers-jj-export".tmp "/usr/local/bin/smithers-jj-export"`},
		{"jj export smoke as developer", `LOGNAME=dev PATH=/home/dev/.local/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin "/usr/local/bin/smithers-jj-export" --version`},
		{"jj export absent is best-effort", "smithers workspace bootstrap: jj export helper payload absent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !strings.Contains(out, tt.want) {
				t.Errorf("rendered bootstrap missing %q", tt.want)
			}
		})
	}

	if !strings.HasPrefix(out, "#!/bin/bash\n") {
		t.Errorf("bootstrap must start with a bash shebang, got prefix %q", out[:min(len(out), 20)])
	}
}

func TestBootstrapTemplateShellQuotesInjectedValues(t *testing.T) {
	// Paths and URLs flow into the script via %q so shell metacharacters in
	// config values cannot break out of the quoted string.
	vars := sampleBootstrapVars()
	vars["CodingHostB64Path"] = `/opt/evil"; rm -rf /; echo "`
	out := renderBootstrap(t, vars)

	if !strings.Contains(out, `"/opt/evil\"; rm -rf /; echo \""`) {
		t.Errorf("CodingHostB64Path with shell metacharacters was not escaped by %%q:\n%s", out)
	}
	if strings.Contains(out, `"; rm -rf /; echo ""`) {
		t.Errorf("unescaped shell injection survived in rendered script")
	}
}

func TestBootstrapTemplateRejectsMissingField(t *testing.T) {
	// Guard against silently rendering "<no value>" if the template gains a
	// field the provisioning code does not supply.
	vars := sampleBootstrapVars()
	delete(vars, "CLIPackageB64Path")

	tmpl, err := template.New("bootstrap").Option("missingkey=error").Parse(BootstrapTemplate)
	if err != nil {
		t.Fatalf("parse bootstrap template: %v", err)
	}
	var sb strings.Builder
	if err := tmpl.Execute(&sb, vars); err == nil {
		t.Fatal("expected execute to fail when a referenced field is missing")
	}
}

func TestDownloadReleaseScriptContract(t *testing.T) {
	// The bootstrap template drives download-release.ts entirely through env
	// vars. Every variable the template exports must be read by the script,
	// and vice versa for the required ones.
	envVars := []string{
		"SMITHERS_DOWNLOAD_MODE",
		"SMITHERS_JJ_RELEASE_API_URL",
		"SMITHERS_JJ_ARCHIVE",
		"SMITHERS_NODE_INDEX_URL",
		"SMITHERS_NODE_MAJOR",
		"SMITHERS_NODE_ARCHIVE",
	}
	for _, v := range envVars {
		t.Run(v, func(t *testing.T) {
			if !strings.Contains(DownloadReleaseScript, "process.env."+v) {
				t.Errorf("download-release.ts does not read %s", v)
			}
		})
	}
	if strings.TrimSpace(DownloadReleaseScript) == "" {
		t.Fatal("DownloadReleaseScript is empty")
	}
}

// A staged binary that fails its smoke run is reported, never deleted. Prod
// 2026-09-15 19:31Z: a kind=vm NixOS guest logged "smithers workspace
// bootstrap: jj export helper runtime smoke failed" and the script removed
// /usr/local/bin/smithers-jj-export, so the coding flow's native Change export
// had nothing to exec. The bootstrap unit had run 2.2s before NixOS activation
// created /lib64/ld-linux-x86-64.so.2 (nix-ld), which the dynamic helper needs.
func TestBootstrapTemplatesNeverDeleteStagedBinariesOnSmokeFailure(t *testing.T) {
	for name, raw := range map[string]string{"container": BootstrapTemplate, "nixos": BootstrapNixOSTemplate} {
		t.Run(name, func(t *testing.T) {
			tmpl, err := template.New(name).Option("missingkey=error").Parse(raw)
			if err != nil {
				t.Fatalf("parse %s template: %v", name, err)
			}
			var sb strings.Builder
			if err := tmpl.Execute(&sb, sampleBootstrapVars()); err != nil {
				t.Fatalf("execute %s template: %v", name, err)
			}
			out := sb.String()

			for _, want := range []string{
				// env -i drops NIX_LD/NIX_LD_LIBRARY_PATH, which nix-ld reads to
				// find the real loader for a dynamic glibc binary.
				`runuser -u dev -- env HOME=/home/dev USER=dev LOGNAME=dev PATH=/home/dev/.local/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin "/usr/local/bin/smithers-jj-export" --version >/tmp/smithers-workspace-jj-export-smoke.log`,
				"jj export helper runtime smoke failed; keeping the staged binary",
				`sed -e "s|^|smithers workspace bootstrap: jj export smoke: |" /tmp/smithers-workspace-jj-export-smoke.log >&2`,
				"coding host runtime smoke failed; keeping the staged binary",
				`/tmp/smithers-workspace-coding-host-smoke.log`,
			} {
				if !strings.Contains(out, want) {
					t.Errorf("rendered %s bootstrap missing %q", name, want)
				}
			}
			for _, banned := range []string{
				`runuser -u dev -- env -i HOME=/home/dev USER=dev LOGNAME=dev PATH=/home/dev/.local/bin:/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin "/usr/local/bin/smithers-jj-export"`,
				"smoke failed\" >&2\n      rm -f \"/usr/local/bin/smithers-jj-export\"",
				"smoke failed\" >&2\n      rm -f \"/usr/local/bin/smithers-coding-host\"",
			} {
				if strings.Contains(out, banned) {
					t.Errorf("rendered %s bootstrap still deletes a staged binary / strips the environment: %q", name, banned)
				}
			}
		})
	}
}
