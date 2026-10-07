package microsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func detectedFixture(files map[string]string) func(string) ([]byte, bool, error) {
	return func(name string) ([]byte, bool, error) {
		if name == "requirements*.txt" {
			matches := map[string]string{}
			for file, body := range files {
				if strings.HasPrefix(file, "requirements") && strings.HasSuffix(file, ".txt") && !strings.Contains(file, "/") {
					matches[file] = body
				}
			}
			if len(matches) == 0 {
				return nil, false, nil
			}
			body, err := json.Marshal(matches)
			return body, true, err
		}
		body, exists := files[name]
		return []byte(body), exists, nil
	}
}

func requireDetectedTool(t *testing.T, recipe Recipe, name, version, file string) {
	t.Helper()
	tool, exists := recipe.Tools[name]
	if !exists {
		t.Fatalf("recipe has no %s tool: %#v", name, recipe.Tools)
	}
	if version != "" && tool.Version != version {
		t.Errorf("%s version = %q; want %q", name, tool.Version, version)
	}
	if tool.Version == "" || tool.File != file {
		t.Errorf("%s detection = %#v; want a version from %q", name, tool, file)
	}
}

func requireDetectedInstall(t *testing.T, recipe Recipe, executable, file, host string) DetectedInstall {
	t.Helper()
	for _, install := range recipe.Installs {
		if len(install.Command) == 0 || install.Command[0] != executable {
			continue
		}
		if !containsDetectedString(install.Files, file) {
			t.Errorf("%s install files = %#v; missing %q", executable, install.Files, file)
		}
		if !containsDetectedString(install.Destinations, host) {
			t.Errorf("%s install destinations = %#v; missing %q", executable, install.Destinations, host)
		}
		if len(install.Offline) == 0 && executable != "go" && executable != "cargo" {
			t.Errorf("%s install has no offline verification command", executable)
		}
		switch executable {
		case "pnpm", "npm", "yarn", "bun", "uv":
			if !containsDetectedString(install.Offline, "--offline") {
				t.Errorf("%s verification can reach network: %#v", executable, install.Offline)
			}
		case "python":
			if !containsDetectedString(install.Offline, "--no-index") {
				t.Errorf("pip verification can reach registry: %#v", install.Offline)
			}
		}
		return install
	}
	t.Fatalf("recipe has no %s install: %#v", executable, recipe.Installs)
	return DetectedInstall{}
}

func containsDetectedString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func requireRecipeRefusal(t *testing.T, err error, files ...string) {
	t.Helper()
	// T-MCH-10 Tests require typed, file-naming refusals; spec §6.2.3
	// classifies actionable invalid declarations as user failures.
	var refusal *RecipeError
	if !errors.As(err, &refusal) {
		t.Fatalf("error = %v (%T); want typed RecipeError", err, err)
	}
	if refusal.Code == "" || refusal.Class != "user" || refusal.Message == "" || refusal.Fix == "" {
		t.Errorf("incomplete user refusal: %#v", refusal)
	}
	for _, file := range files {
		if !strings.Contains(refusal.Message+" "+refusal.Fix, file) {
			t.Errorf("refusal %q / %q does not name %q", refusal.Message, refusal.Fix, file)
		}
	}
}

func TestDetectRecipeCargoMSRVSelectsNewestCompatiblePin(t *testing.T) {
	// Spec §8.6.2 Cargo detection and §8.6.2a pinned resolution must
	// respect Cargo's minimum version, including minors absent from the bundle.
	for _, minimum := range []string{"1.75", "1.78", "1.78.0", "1.85.1"} {
		t.Run(minimum, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{"Cargo.toml": "[package]\nname = 'demo'\nrust-version = '" + minimum + "'\n"}))
			if err != nil {
				t.Fatal(err)
			}
			requireDetectedTool(t, recipe, "rust", ">="+minimum, "Cargo.toml")
			pin, err := resolveDetectedTool("rust", recipe.Tools["rust"])
			if err != nil || pin.Version != "1.85.1" {
				t.Fatalf("MSRV %s resolution = %#v, %v; want latest compatible pin 1.85.1", minimum, pin, err)
			}
		})
	}
	for _, files := range []map[string]string{
		{"Cargo.toml": "[package]\nrust-version = '1.86'\n"},
		{"Cargo.toml": "[package]\nrust-version = '1.85.2'\n"},
		{"Cargo.toml": "[package]\nrust-version = '1.78'\n", "rust-toolchain.toml": "[toolchain]\nchannel = '1.78.0'\n"},
	} {
		recipe, err := DetectRecipe(detectedFixture(files))
		if err != nil {
			t.Fatal(err)
		}
		_, err = resolveDetectedTool("rust", recipe.Tools["rust"])
		requireRecipeRefusal(t, err, recipe.Tools["rust"].File)
	}
}

func TestDetectRecipeReadsOnlySpecifiedFilesAndEmptyRepositoryIsBaseOnly(t *testing.T) {
	// This independent whitelist comes from spec §8.6.2 and T-MCH-10 Changes;
	// T-MCH-10 Tests require a base-only recipe when no listed file exists.
	allowed := map[string]bool{}
	for _, file := range []string{".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Makefile", "setup.py", "pytest.ini", "go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements.txt", "requirements*.txt"} {
		allowed[file] = true
	}
	var reads []string
	read := func(file string) ([]byte, bool, error) {
		reads = append(reads, file)
		if !allowed[file] {
			t.Fatalf("detector reads outside spec whitelist: %q", file)
		}
		return nil, false, nil
	}
	recipe, err := DetectRecipe(read)
	if err != nil {
		t.Fatal(err)
	}
	if len(recipe.Tools) != 0 || recipe.PackageManager != "" || len(recipe.Installs) != 0 {
		t.Fatalf("empty repository must be base-only: %#v", recipe)
	}
	if len(reads) == 0 || recipe.DetectorVersion == "" {
		t.Fatal("detection must read evidence and identify detector version")
	}
	// Outside files exist, but must never be read or change the empty recipe.
	ignored, err := DetectRecipe(detectedFixture(map[string]string{".tool-versions": "nodejs 22.14.0\n", "Dockerfile": "FROM node:22", ".npmrc": "registry=https://private.example/", "Cargo.lock": "lock"}))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(recipe, ignored) {
		t.Fatalf("non-whitelisted files affect detection: %#v vs %#v", recipe, ignored)
	}
}

func TestDetectRecipePropagatesReadFailure(t *testing.T) {
	for _, file := range []string{".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Makefile", "setup.py", "pytest.ini", "go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements*.txt"} {
		t.Run(file, func(t *testing.T) {
			sentinel := errors.New("mirror unavailable")
			_, err := DetectRecipe(func(name string) ([]byte, bool, error) {
				if name == file {
					return nil, false, sentinel
				}
				return nil, false, nil
			})
			if !errors.Is(err, sentinel) {
				t.Fatalf("read failure = %v; want preserved cause", err)
			}
		})
	}
}

func TestDetectRecipeRequirementsGlobProtocol(t *testing.T) {
	// Spec §8.6.2 Python row requires requirements*.txt detection.
	// read("requirements*.txt") enumerates root matches as a JSON object,
	// so discovery remains possible without reading unlisted metadata files.
	recipe, err := DetectRecipe(detectedFixture(map[string]string{"requirements-dev.txt": "pytest==8.3.5\n", "requirements-prod.txt": "requests==2.32.3\n"}))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, install := range recipe.Installs {
		for _, file := range install.Files {
			if strings.HasPrefix(file, "requirements") {
				seen[file] = true
				if !containsDetectedString(install.Command, file) {
					t.Errorf("install does not consume %q: %#v", file, install.Command)
				}
			}
		}
	}
	if !seen["requirements-dev.txt"] || !seen["requirements-prod.txt"] {
		t.Fatalf("glob loses dependency inputs: %#v", seen)
	}
	for _, body := range []string{`{`, `[]`, `{"../requirements.txt":"evil"}`, `{"sub/requirements.txt":"evil"}`, `{".npmrc":"evil"}`, `{"requirements.txt":null}`, `{"requirements.txt":42}`} {
		t.Run(body, func(t *testing.T) {
			_, err := DetectRecipe(func(file string) ([]byte, bool, error) {
				if file == "requirements*.txt" {
					return []byte(body), true, nil
				}
				return nil, false, nil
			})
			requireRecipeRefusal(t, err, "requirements")
		})
	}
}

func TestDetectRecipeRefusesInconsistentRequirementsListing(t *testing.T) {
	_, err := DetectRecipe(func(file string) ([]byte, bool, error) {
		if file == "requirements.txt" {
			return []byte("pytest==8.3.5"), true, nil
		}
		if file == "requirements*.txt" {
			return []byte(`{"requirements.txt":"pytest==7.4.4"}`), true, nil
		}
		return nil, false, nil
	})
	requireRecipeRefusal(t, err, "requirements.txt")
}

func TestDetectRecipeRefusesInvalidBundledDefaults(t *testing.T) {
	for _, fixture := range []struct{ tool, file, body string }{{"node", "pnpm-lock.yaml", "lock"}, {"uv", "pyproject.toml", "[project]\nname = \"demo\"\n"}} {
		t.Run(fixture.tool, func(t *testing.T) {
			original := shippedToolchains.Defaults[fixture.tool]
			shippedToolchains.Defaults[fixture.tool] = "invalid; version"
			defer func() { shippedToolchains.Defaults[fixture.tool] = original }()
			_, err := DetectRecipe(detectedFixture(map[string]string{fixture.file: fixture.body}))
			var refusal *RecipeError
			if !errors.As(err, &refusal) || refusal.Class != "user" {
				t.Fatalf("invalid bundled default produced recipe instead of refusal: %v", err)
			}
		})
	}
}

func TestDetectRecipeDeterministicAcrossRepeatedReads(t *testing.T) {
	files := map[string]string{".node-version": "22.14.0", "package.json": `{"packageManager":"pnpm@10.6.2"}`, "pnpm-lock.yaml": "lock", "go.mod": "module example.org/demo\ngo 1.23.0\n", "Gemfile": "source \"https://rubygems.org\"\nruby \"3.3.7\"\n"}
	first, err := DetectRecipe(detectedFixture(files))
	if err != nil {
		t.Fatal(err)
	}
	for range 20 {
		next, err := DetectRecipe(detectedFixture(files))
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(first, next) {
			t.Fatalf("same evidence produces different recipe: %#v vs %#v", first, next)
		}
	}
}

// The host may interpret only installed detector code. Inherited Node preloads
// and repository lifecycle scripts are data, never executable detector inputs.
func TestMachineEvidenceIgnoresHostPreloadsAndRepositoryScripts(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "host-canary")
	preload := filepath.Join(root, "preload.cjs")
	source := "require('node:fs').writeFileSync(" + fmtQuoted(marker) + ", 'executed')"
	if err := os.WriteFile(preload, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	positive := exec.Command(node, "--require", preload, "--eval", "0")
	positive.Env = []string{"PATH=/usr/bin:/bin"}
	if output, err := positive.CombinedOutput(); err != nil {
		t.Fatalf("canary control: %s: %v", output, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("canary did not run", err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require "+preload)
	recipe, err := DetectRecipe(detectedFixture(map[string]string{
		"package.json":    `{"scripts":{"install":"node HOST-CANARY.cjs"},"packageManager":"pnpm@9"}`,
		"HOST-CANARY.cjs": source,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if recipe.PackageManager != "pnpm" {
		t.Fatal(recipe)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("host detector executed a preload", err)
	}
}

func fmtQuoted(value string) string { data, _ := json.Marshal(value); return string(data) }

func TestMachineEvidencePreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := detectRecipe(ctx, detectedFixture(map[string]string{".node-version": "22"}), "", false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v; want canceled", err)
	}
}
