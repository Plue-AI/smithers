package microsandbox

import (
	"encoding/json"
	"errors"
	"fmt"
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

func TestDetectRecipeNodeVersionFiles(t *testing.T) {
	// Spec §8.6.2 Node row: these three files supply the declared Node version.
	for _, fixture := range []struct{ name, body, file string }{
		{"node-version", " 22.14.0\n", ".node-version"},
		{"nvmrc", "v22.14.0\n", ".nvmrc"},
		{"engines", `{"engines":{"node":"22.14.0"}}`, "package.json"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{fixture.file: fixture.body}))
			if err != nil {
				t.Fatal(err)
			}
			requireDetectedTool(t, recipe, "node", "22.14.0", fixture.file)
			if recipe.DetectorVersion == "" {
				t.Fatal("recipe must identify its detector version for cache invalidation")
			}
		})
	}
}

func TestDetectRecipeNodeVersionPrecedence(t *testing.T) {
	// T-MCH-10 Tests: .node-version > .nvmrc > package.json#engines.node.
	files := map[string]string{".node-version": "22.14.0", ".nvmrc": "20.19.0", "package.json": `{"engines":{"node":"18.20.8"}}`}
	recipe, err := DetectRecipe(detectedFixture(files))
	if err != nil {
		t.Fatal(err)
	}
	requireDetectedTool(t, recipe, "node", "22.14.0", ".node-version")
	delete(files, ".node-version")
	recipe, err = DetectRecipe(detectedFixture(files))
	if err != nil {
		t.Fatal(err)
	}
	requireDetectedTool(t, recipe, "node", "20.19.0", ".nvmrc")
	delete(files, ".nvmrc")
	recipe, err = DetectRecipe(detectedFixture(files))
	if err != nil {
		t.Fatal(err)
	}
	requireDetectedTool(t, recipe, "node", "18.20.8", "package.json")
}

func TestDetectRecipeNodeVersionPrecedenceIgnoresOverriddenInvalidVersion(t *testing.T) {
	// T-MCH-10 precedence: only the winning file supplies the §8.6.2 Node version.
	for _, lower := range []string{"lts/*", "lts/jod", "../../node", "", "22.14.0\n20.19.0"} {
		t.Run(lower, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{
				".node-version": "v22.14.0", ".nvmrc": lower,
				"package.json": `{"engines":{"node":"invalid"}}`,
			}))
			if err != nil {
				t.Fatal(err)
			}
			requireDetectedTool(t, recipe, "node", "22.14.0", ".node-version")
		})
	}
	_, err := DetectRecipe(detectedFixture(map[string]string{".node-version": "invalid", ".nvmrc": "22.14.0"}))
	requireRecipeRefusal(t, err, ".node-version")
}

func TestDetectRecipeIgnoresRubyFilesIncludingAlongsideNode(t *testing.T) {
	// Spec §8.6.2 excludes Ruby even when its files would refuse preparation.
	for _, files := range []map[string]string{
		{"Gemfile": "ruby '3.4.2'\n", ".ruby-version": "3.4.2"},
		{"Gemfile": "ruby 'invalid'\n", ".ruby-version": "invalid"},
		{"Gemfile": "ruby '3.4.2'\n", ".ruby-version": "3.4.2", "package.json": `{"packageManager":"pnpm@9.15.9"}`, "pnpm-lock.yaml": "lock"},
		{"Gemfile": "source 'https://rubygems.org'\nruby '~> 3.2'\n", ".ruby-version": "3.3.7", ".node-version": "22", "package.json": `{"packageManager":"pnpm@9.15.9"}`, "pnpm-lock.yaml": "lock"},
	} {
		t.Run(fmt.Sprint(files), func(t *testing.T) {
			read := detectedFixture(files)
			recipe, err := DetectRecipe(func(file string) ([]byte, bool, error) {
				if file == "Gemfile" || file == ".ruby-version" {
					t.Errorf("detector read unsupported file %s", file)
				}
				return read(file)
			})
			if err != nil {
				t.Fatal(err)
			}
			delete(files, "Gemfile")
			delete(files, ".ruby-version")
			want, err := DetectRecipe(detectedFixture(files))
			if err != nil || !reflect.DeepEqual(recipe, want) {
				t.Fatalf("Ruby files changed recipe: got %#v; want %#v (err %v)", recipe, want, err)
			}
			// Spec §8.6.2a: ignoring out-of-envelope files must leave a
			// usable pinned Node recipe, not merely successful detection.
			for name, tool := range recipe.Tools {
				pin, err := resolveDetectedTool(name, tool)
				if err != nil || pin.Version == "" || pin.URL == "" || pin.SHA256 == "" {
					t.Errorf("Node recipe with ignored Ruby files cannot resolve %s: %#v, %v", name, pin, err)
				}
			}
		})
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

func TestDetectRecipePackageManagerLockfiles(t *testing.T) {
	// Spec §8.6.2 package-manager row and T-MCH-10 Changes:
	// the listed lockfiles select the manager and locked install command.
	for _, fixture := range []struct {
		file, manager string
		command       []string
	}{
		{"pnpm-lock.yaml", "pnpm", []string{"pnpm", "install", "--frozen-lockfile"}},
		{"package-lock.json", "npm", []string{"npm", "ci"}},
		{"yarn.lock", "yarn", []string{"yarn", "install", "--frozen-lockfile"}},
		{"bun.lock", "bun", []string{"bun", "install", "--frozen-lockfile"}},
		{"bun.lockb", "bun", []string{"bun", "install", "--frozen-lockfile"}},
	} {
		t.Run(fixture.file, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{fixture.file: "lock data"}))
			if err != nil {
				t.Fatal(err)
			}
			if recipe.PackageManager != fixture.manager {
				t.Errorf("manager = %q; want %q", recipe.PackageManager, fixture.manager)
			}
			install := requireDetectedInstall(t, recipe, fixture.manager, fixture.file, "registry.npmjs.org")
			if !reflect.DeepEqual(install.Command, fixture.command) {
				t.Errorf("command = %#v; want %#v", install.Command, fixture.command)
			}
		})
	}
}

func TestDetectRecipeDeclaredPackageManagerWinsConflictingLockfiles(t *testing.T) {
	// T-MCH-10 Tests: package.json#packageManager wins over lockfiles.
	recipe, err := DetectRecipe(detectedFixture(map[string]string{
		"package.json":   `{"packageManager":"pnpm@10.6.2","engines":{"node":"22.14.0"}}`,
		"pnpm-lock.yaml": "lock", "package-lock.json": "{}", "yarn.lock": "lock", "bun.lock": "lock",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if recipe.PackageManager != "pnpm" {
		t.Fatalf("manager = %q; want pnpm", recipe.PackageManager)
	}
	requireDetectedTool(t, recipe, "pnpm", "10.6.2", "package.json")
	if len(recipe.Installs) != 1 {
		t.Fatalf("manager precedence must select one install: %#v", recipe.Installs)
	}
	requireDetectedInstall(t, recipe, "pnpm", "pnpm-lock.yaml", "registry.npmjs.org")
}

func TestDetectRecipeDeclaredPackageManagers(t *testing.T) {
	// Spec §8.6.2 package-manager row: preserve the declared manager/version.
	for _, fixture := range []struct{ manager, version string }{{"pnpm", "9.15.5"}, {"npm", "10.9.2"}, {"yarn", "1.22.22"}, {"bun", "1.2.5"}} {
		t.Run(fixture.manager, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{"package.json": fmt.Sprintf(`{"packageManager":%q}`, fixture.manager+"@"+fixture.version)}))
			if err != nil {
				t.Fatal(err)
			}
			if recipe.PackageManager != fixture.manager {
				t.Errorf("manager = %q; want %q", recipe.PackageManager, fixture.manager)
			}
			requireDetectedTool(t, recipe, fixture.manager, fixture.version, "package.json")
			requireDetectedInstall(t, recipe, fixture.manager, "package.json", "registry.npmjs.org")
		})
	}
}

func TestDetectRecipePackageJSONWithoutManagerUsesNpm(t *testing.T) {
	// T-MCH-10 Changes ports Checklist.ts:174-226 package-manager rules,
	// including npm when package.json has neither a manager nor a lockfile.
	recipe, err := DetectRecipe(detectedFixture(map[string]string{"package.json": `{"name":"demo"}`}))
	if err != nil {
		t.Fatal(err)
	}
	if recipe.PackageManager != "npm" {
		t.Fatalf("manager = %q; want npm", recipe.PackageManager)
	}
	requireDetectedInstall(t, recipe, "npm", "package.json", "registry.npmjs.org")
}

func TestDetectRecipeConflictingLockfilesRefuse(t *testing.T) {
	// T-MCH-10 Tests: incompatible lockfiles refuse and name both files.
	locks := []string{"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"}
	for i, first := range locks {
		for _, second := range locks[i+1:] {
			if first == "bun.lock" && second == "bun.lockb" {
				continue
			}
			t.Run(first+"+"+second, func(t *testing.T) {
				_, err := DetectRecipe(detectedFixture(map[string]string{first: "lock", second: "lock"}))
				requireRecipeRefusal(t, err, first, second)
			})
		}
	}
	// Bun's text and binary formats are one manager, not a conflict.
	recipe, err := DetectRecipe(detectedFixture(map[string]string{"bun.lock": "lock", "bun.lockb": "lock"}))
	if err != nil {
		t.Fatal(err)
	}
	if recipe.PackageManager != "bun" || len(recipe.Installs) != 1 {
		t.Fatalf("same-manager locks = %#v", recipe)
	}
}

func TestDetectRecipeLanguageRows(t *testing.T) {
	// Spec §8.6.2 Go/Rust/Python rows and T-MCH-10 Tests require a fixture
	// for each listed source, tool version, and dependency-install command.
	for _, fixture := range []struct {
		name                                           string
		files                                          map[string]string
		tool, version, source, executable, input, host string
		command                                        []string
	}{
		{"go directive", map[string]string{"go.mod": "module example.org/test\n\ngo 1.23.0\n"}, "go", "1.23.0", "go.mod", "go", "go.mod", "proxy.golang.org", []string{"go", "mod", "download"}},
		{"go toolchain", map[string]string{"go.mod": "module example.org/test\ngo 1.23.0\ntoolchain go1.23.8\n"}, "go", "1.23.8", "go.mod", "go", "go.mod", "proxy.golang.org", []string{"go", "mod", "download"}},
		{"rust toolchain", map[string]string{"rust-toolchain.toml": "[toolchain]\nchannel = \"1.85.0\"\n", "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nrust-version = \"1.80.0\"\n"}, "rust", "1.85.0", "rust-toolchain.toml", "cargo", "Cargo.toml", "index.crates.io", []string{"cargo", "fetch"}},
		{"rust stable channel", map[string]string{"rust-toolchain.toml": "[toolchain]\nchannel = 'stable'\n"}, "rust", "stable", "rust-toolchain.toml", "", "", "", nil},
		{"cargo manifest", map[string]string{"Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nrust-version = \"1.85.0\"\n"}, "rust", ">=1.85.0", "Cargo.toml", "cargo", "Cargo.toml", "index.crates.io", []string{"cargo", "fetch"}},
		{"python version", map[string]string{".python-version": "3.12.9\n"}, "python", "3.12.9", ".python-version", "", "", "", nil},
		{"python pyproject", map[string]string{"pyproject.toml": "[project]\nname = \"demo\"\nversion = \"0.1.0\"\nrequires-python = \"==3.12.9\"\n"}, "python", "==3.12.9", "pyproject.toml", "uv", "pyproject.toml", "pypi.org", nil},
		{"python uv", map[string]string{".python-version": "3.12.9", "pyproject.toml": "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n", "uv.lock": "version = 1\n"}, "python", "3.12.9", ".python-version", "uv", "uv.lock", "pypi.org", []string{"uv", "sync", "--frozen"}},
		{"python requirements", map[string]string{".python-version": "3.12.9", "requirements.txt": "requests==2.32.3\n"}, "python", "3.12.9", ".python-version", "python", "requirements.txt", "pypi.org", []string{"python", "-m", "pip", "install", "-r", "requirements.txt"}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(fixture.files))
			if err != nil {
				t.Fatal(err)
			}
			requireDetectedTool(t, recipe, fixture.tool, fixture.version, fixture.source)
			if fixture.executable != "" {
				install := requireDetectedInstall(t, recipe, fixture.executable, fixture.input, fixture.host)
				if fixture.command != nil && !reflect.DeepEqual(install.Command, fixture.command) {
					t.Errorf("command = %#v; want %#v", install.Command, fixture.command)
				}
			}
		})
	}
}

func TestDetectRecipeLanguageManifestsWithoutVersionChooseDefaultTools(t *testing.T) {
	// Spec §8.6.2 detects these language rows even without a version;
	// §8.6.2a supplies their pinned defaults from the install bundle.
	for _, fixture := range []struct{ file, body, tool, executable, host string }{
		{"Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n", "rust", "cargo", "index.crates.io"},
		{"pyproject.toml", "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n", "python", "uv", "pypi.org"},
		{"uv.lock", "version = 1\n", "python", "uv", "pypi.org"},
		{"requirements.txt", "requests==2.32.3\n", "python", "python", "pypi.org"},
	} {
		t.Run(fixture.file, func(t *testing.T) {
			recipe, err := DetectRecipe(detectedFixture(map[string]string{fixture.file: fixture.body}))
			if err != nil {
				t.Fatal(err)
			}
			requireDetectedTool(t, recipe, fixture.tool, "", fixture.file)
			requireDetectedInstall(t, recipe, fixture.executable, fixture.file, fixture.host)
		})
	}
}

func TestDetectRecipePythonVersionFilePrecedence(t *testing.T) {
	// Spec §8.6.2 Python row: the explicit .python-version declaration
	// supplies the tool while pyproject.toml/uv.lock supply dependency inputs.
	recipe, err := DetectRecipe(detectedFixture(map[string]string{
		".python-version": "3.12.9", "pyproject.toml": "[project]\nrequires-python = \"==3.11.11\"\n", "uv.lock": "version = 1\n",
	}))
	if err != nil {
		t.Fatal(err)
	}
	requireDetectedTool(t, recipe, "python", "3.12.9", ".python-version")
	if len(recipe.Installs) != 1 {
		t.Fatalf("precedence produces duplicate installs: %#v", recipe.Installs)
	}
	requireDetectedInstall(t, recipe, "uv", "uv.lock", "pypi.org")
}

func TestDetectRecipeReadsOnlySpecifiedFilesAndEmptyRepositoryIsBaseOnly(t *testing.T) {
	// This independent whitelist comes from spec §8.6.2 and T-MCH-10 Changes;
	// T-MCH-10 Tests require a base-only recipe when no listed file exists.
	allowed := map[string]bool{}
	for _, file := range []string{".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements.txt", "requirements*.txt"} {
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

func TestDetectRecipeInvalidEvidenceRefusesWithFile(t *testing.T) {
	for _, fixture := range []struct{ file, body string }{
		{".node-version", "22.14.0; curl evil"}, {".node-version", ""}, {".nvmrc", "../../node"},
		{"package.json", "{"}, {"package.json", `{"engines":{"node":22}}`},
		{"package.json", `{"packageManager":"unknown@1.2.3"}`}, {"package.json", `{"packageManager":"pnpm@$(id)"}`},
		{"go.mod", "module example.org/demo\ngo invalid\n"}, {"go.mod", "module example.org/demo\ngo 1.23.0\ntoolchain goevil\n"},
		{"rust-toolchain.toml", "[toolchain]\nchannel = \"1.85.0; id\"\n"}, {"rust-toolchain.toml", "[toolchain\nchannel = \"1.85.0\""},
		{"Cargo.toml", "[package\n"}, {".python-version", "3.12.9\n3.11.11"}, {"pyproject.toml", "[project\n"},
		{"Cargo.toml", "[package]\nrust-version = '>=1.78'\n"},
		{"Cargo.toml", "[package]\nrust-version = 'v1.78'\n"},
		{".node-version", "22.14.0\n20.19.0"}, {".nvmrc", ">=22 <23"}, {".python-version", ">=3.12 <3.13"},
		{"package.json", `{"packageManager":"pnpm@^9.15.0"}`}, {"go.mod", "module example.org/test\ngo >=1.23.0\n"},
		{"rust-toolchain.toml", "[toolchain]\nchannel = \"^1.85.0\"\n"},
		{"package.json", `{"engines":{"node":"evil; id"}}`},
		{"go.mod", "module example.org/test\n"}, {"go.mod", "module example.org/test\ngo 1.23.0\ngo 1.23.1\n"},
		{"rust-toolchain.toml", "[toolchain]\ncomponents = [\"clippy\"]\n"},
		{"pyproject.toml", "[project]\nrequires-python = \"^^3.13.0\"\n"},
	} {
		t.Run(fmt.Sprintf("%s/%s", fixture.file, fixture.body), func(t *testing.T) {
			_, err := DetectRecipe(detectedFixture(map[string]string{fixture.file: fixture.body}))
			requireRecipeRefusal(t, err, fixture.file)
		})
	}
}

func TestDetectRecipePropagatesReadFailure(t *testing.T) {
	for _, file := range []string{".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements*.txt"} {
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
