package microsandbox

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestBundledToolchainsManifestHasPinnedArtifactsAndResolvableDefaults(t *testing.T) {
	// Spec §8.6.2 defines the supported tools; §8.6.2a and T-MCH-10 Tests
	// require each manifest version to carry a download URL and 64-hex SHA-256.
	data, err := os.ReadFile("toolchains.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema   string                         `json:"schema"`
		Defaults map[string]string              `json:"defaults"`
		Tools    map[string]map[string]download `json:"tools"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Schema != "smithers.toolchains/v1" {
		t.Fatalf("manifest schema = %q", manifest.Schema)
	}
	for _, tool := range []string{"node", "pnpm", "npm", "yarn", "bun", "go", "rust", "python", "uv"} {
		requested := defaultToolVersion(tool)
		if requested == "" || requested != manifest.Defaults[tool] {
			t.Errorf("%s default = %q; manifest = %q", tool, requested, manifest.Defaults[tool])
		}
		resolved, err := resolveDetectedTool(tool, DetectedTool{Version: requested, File: "default fixture"})
		if err != nil {
			t.Errorf("resolve default %s@%s: %v", tool, requested, err)
			continue
		}
		if _, exists := manifest.Tools[tool][resolved.Version]; !exists {
			t.Errorf("default %s resolves outside manifest: %#v", tool, resolved)
		}
	}
	for tool, versions := range manifest.Tools {
		if len(versions) == 0 {
			t.Errorf("%s manifest has no artifacts", tool)
		}
		for version, pin := range versions {
			if version != pin.Version {
				t.Errorf("%s key %q disagrees with artifact version %q", tool, version, pin.Version)
			}
			parsed, err := url.Parse(pin.URL)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
				t.Errorf("%s@%s invalid artifact URL %q", tool, version, pin.URL)
			}
			hash, err := hex.DecodeString(pin.SHA256)
			if err != nil || len(hash) != 32 || pin.SHA256 != strings.ToLower(pin.SHA256) {
				t.Errorf("%s@%s has no canonical SHA-256: %q", tool, version, pin.SHA256)
			}
			if pin.SHA256 == strings.Repeat("0", 64) || pin.SHA256 == strings.Repeat("a", 64) {
				t.Errorf("%s@%s uses a placeholder checksum", tool, version)
			}
			resolved, err := resolveDetectedTool(tool, DetectedTool{Version: version, File: "artifact fixture"})
			if err != nil || resolved != pin {
				t.Errorf("exact %s@%s changes its pinned artifact: got %#v err=%v want %#v", tool, version, resolved, err, pin)
			}
		}
	}
}

func TestResolveDetectedToolExactAndNearestPatch(t *testing.T) {
	// Spec §8.6.2a and T-MCH-10 Tests: exact hits stay pinned; absent patches
	// use the nearest pin in the same minor (22.14.0 in this shipped bundle).
	for _, fixture := range []struct{ name, requested, want string }{
		{"exact", "22.14.0", "22.14.0"},
		{"nearest same minor", "22.14.99", "22.14.0"},
		{"minor", "22.14", "22.14.0"},
		{"major", "22", "22.14.0"},
		{"engine range", ">=22 <23", "22.14.0"},
		{"caret engine range", "^22.14.0", "22.14.0"},
		{"tilde engine range", "~22.14.0", "22.14.0"},
		{"tilde major range", "~22", "22.14.0"},
		{"wildcard patch", "22.14.x", "22.14.0"},
		{"comma separated range", ">=22, <23", "22.14.0"},
		{"spaced operators", ">= 22 < 23", "22.14.0"},
		{"alternative range", ">=99 || >=22 <23", "22.14.0"},
		{"strict lower bound", ">22 <23", "22.14.0"},
		{"inclusive upper bound", ">=22 <=22.14.0", "22.14.0"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			pin, err := resolveDetectedTool("node", DetectedTool{Version: fixture.requested, File: "package.json"})
			if err != nil {
				t.Fatal(err)
			}
			if pin.Version != fixture.want || pin.URL == "" || pin.SHA256 == "" {
				t.Fatalf("resolution %q = %#v; want %q complete artifact", fixture.requested, pin, fixture.want)
			}
		})
	}
}

func TestResolveDetectedToolCannotCrossMinorOrMajorForUnavailableExactVersion(t *testing.T) {
	// Spec §8.6.2a: no pinned patch in the requested minor must refuse,
	// naming the declaration file instead of crossing a minor/major boundary.
	for _, requested := range []string{"22.99.0", "99.14.0", "22.99", ">=99 <100", ">=22.99 <23", ">=22.14.99 <23", "==22.14.99", "^22.14.99", "evil;$(id)", "^^22.14.0", "~=22.14.0"} {
		t.Run(requested, func(t *testing.T) {
			_, err := resolveDetectedTool("node", DetectedTool{Version: requested, File: ".nvmrc"})
			requireRecipeRefusal(t, err, ".nvmrc")
		})
	}
	_, err := resolveDetectedTool("unlisted", DetectedTool{Version: "1.0.0", File: "package.json"})
	requireRecipeRefusal(t, err, "package.json")
}

func TestResolveDetectedToolPythonAndRustVersionForms(t *testing.T) {
	// Spec §8.6.2 Python/Rust rows provide version declarations; §8.6.2a
	// resolves them to the listed pinned versions in the shipped bundle.
	for _, fixture := range []struct{ tool, requested, want, file string }{
		{"python", "==3.13.16", "3.13.16", "pyproject.toml"},
		{"python", ">=3.13 <3.14", "3.13.16", "pyproject.toml"},
		{"rust", "stable", "1.85.1", "rust-toolchain.toml"},
		{"rust", "1.85.0", "1.85.1", "rust-toolchain.toml"},
		{"uv", "^0.12.0", "0.12.22", "uv.lock"},
	} {
		t.Run(fixture.tool+"/"+fixture.requested, func(t *testing.T) {
			pin, err := resolveDetectedTool(fixture.tool, DetectedTool{Version: fixture.requested, File: fixture.file})
			if err != nil {
				t.Fatal(err)
			}
			if pin.Version != fixture.want {
				t.Fatalf("resolved version %q; want %q", pin.Version, fixture.want)
			}
		})
	}
}

func TestShippedToolchainManifestExcludesRuby(t *testing.T) {
	// Spec §8.6.2 and T-MCH-10 Scope explicitly exclude Ruby.
	if _, ok := shippedToolchains.Tools["ruby"]; ok {
		t.Fatal("Ruby artifact remains in supported toolchain manifest")
	}
	if _, ok := shippedToolchains.Defaults["ruby"]; ok {
		t.Fatal("Ruby default remains in supported toolchain manifest")
	}
}

func TestResolveDetectedToolRustMinimumAndExplicitPin(t *testing.T) {
	// Spec §8.6.2a selects pinned artifacts; Cargo.toml supplies a minimum
	// under §8.6.2, whereas rust-toolchain.toml supplies an explicit request.
	original := shippedToolchains.Tools["rust"]
	defer func() { shippedToolchains.Tools["rust"] = original }()
	latest := original["1.85.1"]
	older := latest
	older.Version = "1.78.0"
	newest := latest
	newest.Version = "1.90.0"
	shippedToolchains.Tools["rust"] = map[string]download{"1.78.0": older, "1.85.1": latest, "1.90.0": newest}
	for _, fixture := range []struct{ version, file, want string }{
		{">=1.75", "Cargo.toml", "1.90.0"},
		{">=1.78.0", "Cargo.toml", "1.90.0"},
		{">=1.85.1", "Cargo.toml", "1.90.0"},
		{">=1.90.0", "Cargo.toml", "1.90.0"},
		{"1.78.0", "rust-toolchain.toml", "1.78.0"},
		{"1.78.1", "rust-toolchain.toml", "1.78.0"},
		{"1.85.1", "rust-toolchain.toml", "1.85.1"},
	} {
		pin, err := resolveDetectedTool("rust", DetectedTool{Version: fixture.version, File: fixture.file})
		if err != nil || pin.Version != fixture.want {
			t.Errorf("%s %s resolved to %#v, %v; want %s", fixture.file, fixture.version, pin, err, fixture.want)
		}
	}
	for _, minimum := range []string{">=1.90.1", ">=1.91"} {
		_, err := resolveDetectedTool("rust", DetectedTool{Version: minimum, File: "Cargo.toml"})
		requireRecipeRefusal(t, err, "Cargo.toml")
	}
}

func TestResolveDetectedToolZeroMajorCaretRangeDoesNotCrossMinor(t *testing.T) {
	_, err := resolveDetectedTool("uv", DetectedTool{Version: "^0.11.0", File: "uv.lock"})
	requireRecipeRefusal(t, err, "uv.lock")
	_, err = resolveDetectedTool("uv", DetectedTool{Version: "^0.0.1", File: "uv.lock"})
	requireRecipeRefusal(t, err, "uv.lock")
}

func TestToolchainVersionValidationRejectsMalformedAndOverflowValues(t *testing.T) {
	for _, value := range []string{"", "||", "^^22", "~=22", "22.14.0;id", "999999999999999999999999999999999999999999"} {
		if validRequestedVersion(value) {
			t.Errorf("invalid requested version accepted: %q", value)
		}
	}
	if !validRequestedVersion("stable") {
		t.Fatal("Rust stable declaration rejected")
	}
	if _, _, valid := numericVersion("999999999999999999999999999999999999999999"); valid {
		t.Fatal("overflow version accepted")
	}
	if matchesRange([3]int{22, 14, 0}, "not-a-range") {
		t.Fatal("malformed range matched a version")
	}
}

func TestDecodeToolchainManifestRefusesCorruptShippedArtifacts(t *testing.T) {
	// T-MCH-10 Changes (toolchains.go) requires a manifest schema check;
	// spec §8.6.2a requires complete version/URL/SHA-256 artifact identities.
	validPin := download{Version: "22.14.0", URL: "https://nodejs.org/dist/v22.14.0/node.tar.xz", SHA256: strings.Repeat("b", 64)}
	for _, fixture := range []struct {
		name, raw, schema, key string
		mutate                 func(*download)
	}{
		{name: "malformed JSON", raw: "{"},
		{name: "unsupported schema", schema: "unknown"},
		{name: "mismatched version", mutate: func(pin *download) { pin.Version = "22.14.1" }},
		{name: "invalid checksum", mutate: func(pin *download) { pin.SHA256 = "untrusted" }},
		{name: "invalid numeric version", key: "evil", mutate: func(pin *download) { pin.Version = "evil" }},
		{name: "invalid artifact URL", mutate: func(pin *download) { pin.URL = "http://nodejs.org/node.tar.xz" }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			original := toolchainManifestJSON
			defer func() { toolchainManifestJSON = original }()
			if fixture.raw != "" {
				toolchainManifestJSON = []byte(fixture.raw)
			} else {
				pin := validPin
				if fixture.mutate != nil {
					fixture.mutate(&pin)
				}
				schema, key := fixture.schema, fixture.key
				if schema == "" {
					schema = "smithers.toolchains/v1"
				}
				if key == "" {
					key = "22.14.0"
				}
				var err error
				toolchainManifestJSON, err = json.Marshal(toolchainManifest{Schema: schema, Defaults: map[string]string{"node": "22"}, Tools: map[string]map[string]download{"node": {key: pin}}})
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err := decodeToolchainManifest(); err == nil {
				t.Fatal("corrupt manifest was accepted")
			}
		})
	}
}

func TestResolveDetectedToolPreservesShippedManifestFailure(t *testing.T) {
	original := shippedToolchainsError
	defer func() { shippedToolchainsError = original }()
	sentinel := errors.New("invalid manifest checksum")
	shippedToolchainsError = sentinel
	_, err := resolveDetectedTool("node", DetectedTool{Version: "22", File: "package.json"})
	if !errors.Is(err, sentinel) {
		t.Fatalf("manifest failure = %v; want original cause", err)
	}
}
