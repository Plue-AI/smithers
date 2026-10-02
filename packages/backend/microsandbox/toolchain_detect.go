package microsandbox

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// DetectorVersion is part of every detected layer's content identity.
const DetectorVersion = "smithers.toolchain-detect/v2"

// RecipeError is an actionable machine preparation or command failure.
type RecipeError struct {
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
}

func (e *RecipeError) Error() string { return e.Message }

func recipeRefusal(file, message string) error {
	return &RecipeError{Code: "invalid_machine_recipe", Class: "user", Message: file + ": " + message, Fix: "Change " + file}
}

type DetectedTool struct {
	Version string `json:"version"`
	File    string `json:"file"`
}

type DetectedInstall struct {
	Command      []string `json:"command"`
	Offline      []string `json:"offline,omitempty"`
	Files        []string `json:"files"`
	Destinations []string `json:"destinations"`
}

// Recipe contains data only. Detection never runs repository code or fetches
// the network. Tool artifacts resolve against the shipped pinned manifest.
type Recipe struct {
	DetectorVersion string                  `json:"detectorVersion"`
	Tools           map[string]DetectedTool `json:"tools"`
	PackageManager  string                  `json:"packageManager,omitempty"`
	Installs        []DetectedInstall       `json:"installs,omitempty"`
}

var detectionFiles = []string{
	".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb",
	"go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements.txt", "requirements*.txt",
}

var goDirective = regexp.MustCompile(`(?m)^\s*(go|toolchain)\s+(\S+)\s*(?://[^\n]*)?$`)

// DetectRecipe reads only the files in engineering spec 8.6.2. To enumerate
// requirements*.txt with this file-reader signature, read("requirements*.txt")
// returns a JSON object of matching root filenames to their text. Readers
// without any matches return absent, just as for an absent ordinary file.
func DetectRecipe(read func(string) ([]byte, bool, error)) (Recipe, error) {
	r := Recipe{DetectorVersion: DetectorVersion, Tools: map[string]DetectedTool{}}
	files := map[string][]byte{}
	for _, file := range detectionFiles {
		data, exists, err := read(file)
		if err != nil {
			return r, fmt.Errorf("read %s: %w", file, err)
		}
		if !exists {
			continue
		}
		if file != "requirements*.txt" {
			if file == ".python-version" {
				version := strings.TrimSpace(string(data))
				if _, _, valid := numericVersion(version); !valid || !numericVersionPattern.MatchString(version) {
					return r, recipeRefusal(file, "expected one numeric version")
				}
			}
			files[file] = data
			continue
		}
		var matches map[string]*string
		if err := json.Unmarshal(data, &matches); err != nil {
			return r, recipeRefusal(file, "invalid requirements file listing")
		}
		for name, contents := range matches {
			if contents == nil {
				return r, recipeRefusal(file, "requirements contents must be text")
			}
			matched, _ := path.Match("requirements*.txt", name)
			if !matched || path.Base(name) != name || strings.ContainsAny(name, "\\\x00") {
				return r, recipeRefusal(file, "invalid requirements filename "+name)
			}
			if prior, ok := files[name]; ok && string(prior) != *contents {
				return r, recipeRefusal(name, "inconsistent contents in requirements listing")
			}
			files[name] = []byte(*contents)
		}
	}
	tool := func(name, version, file string) error {
		version = strings.TrimSpace(version)
		if version == "" {
			version = defaultToolVersion(name)
		}
		_, _, numeric := numericVersion(version)
		rangeAllowed := (name == "node" && file == "package.json") || (name == "python" && file == "pyproject.toml") || (name == "rust" && file == "Cargo.toml")
		valid := numeric && numericVersionPattern.MatchString(version)
		if rangeAllowed {
			valid = validRequestedVersion(version)
		} else if name == "rust" && version == "stable" {
			valid = true
		}
		if !valid {
			return recipeRefusal(file, "invalid "+name+" version "+version)
		}
		r.Tools[name] = DetectedTool{Version: version, File: file}
		return nil
	}
	install := func(command, offline, inputs, hosts []string) {
		r.Installs = append(r.Installs, DetectedInstall{Command: command, Offline: offline, Files: sortedCopy(inputs), Destinations: sortedCopy(hosts)})
	}
	var manifest struct {
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
		PackageManager string `json:"packageManager"`
	}
	if data, ok := files["package.json"]; ok {
		if err := json.Unmarshal(data, &manifest); err != nil {
			return r, recipeRefusal("package.json", "invalid JSON: "+err.Error())
		}
	}
	version, versionFile := manifest.Engines.Node, "package.json"
	if data, ok := files[".nvmrc"]; ok {
		version, versionFile = strings.TrimSpace(string(data)), ".nvmrc"
	}
	if data, ok := files[".node-version"]; ok {
		version, versionFile = strings.TrimSpace(string(data)), ".node-version"
	}
	if versionFile == ".node-version" || versionFile == ".nvmrc" {
		version = strings.TrimPrefix(version, "v")
		if _, _, valid := numericVersion(version); !valid || !numericVersionPattern.MatchString(version) {
			return r, recipeRefusal(versionFile, "expected one numeric version")
		}
	}
	if _, ok := files["package.json"]; ok || version != "" {
		if err := tool("node", strings.TrimPrefix(version, "v"), versionFile); err != nil {
			return r, err
		}
	}
	locks := []struct{ file, manager string }{{"pnpm-lock.yaml", "pnpm"}, {"package-lock.json", "npm"}, {"yarn.lock", "yarn"}, {"bun.lock", "bun"}, {"bun.lockb", "bun"}}
	manager, managerVersion, managerFile := "", "", "package.json"
	var chosenLocks []string
	if manifest.PackageManager != "" {
		manager, managerVersion, _ = strings.Cut(manifest.PackageManager, "@")
		// Corepack's packageManager may carry its reviewed integrity suffix.
		managerVersion = strings.SplitN(managerVersion, "+sha", 2)[0]
	}
	for _, lock := range locks {
		if _, ok := files[lock.file]; !ok {
			continue
		}
		if manifest.PackageManager == "" && manager != "" && manager != lock.manager {
			return r, recipeRefusal(strings.Join(append(chosenLocks, lock.file), " and "), "conflicting package-manager lockfiles; set package.json#packageManager")
		}
		if manager == "" {
			manager, managerFile = lock.manager, lock.file
		}
		if manager == lock.manager {
			chosenLocks = append(chosenLocks, lock.file)
		}
	}
	if manager == "" {
		if _, ok := files["package.json"]; ok {
			manager = "npm"
		}
	}
	if manager != "" {
		if manager != "pnpm" && manager != "npm" && manager != "yarn" && manager != "bun" {
			return r, recipeRefusal(managerFile, "unsupported package manager "+manager)
		}
		if _, ok := r.Tools["node"]; !ok {
			if err := tool("node", "", managerFile); err != nil {
				return r, err
			}
		}
		if err := tool(manager, managerVersion, managerFile); err != nil {
			return r, err
		}
		r.PackageManager = manager
		inputs := append([]string{"package.json"}, chosenLocks...)
		var command, offline []string
		switch manager {
		case "pnpm":
			command = []string{"pnpm", "install"}
			if len(chosenLocks) > 0 {
				command = append(command, "--frozen-lockfile")
			}
			offline = append(append([]string(nil), command...), "--offline")
		case "npm":
			command = []string{"npm", "install"}
			if len(chosenLocks) > 0 {
				command = []string{"npm", "ci"}
			}
			offline = append(append([]string(nil), command...), "--offline")
		case "yarn":
			command = []string{"yarn", "install"}
			if len(chosenLocks) > 0 {
				command = append(command, "--frozen-lockfile")
			}
			offline = append(append([]string(nil), command...), "--offline")
		case "bun":
			command = []string{"bun", "install"}
			if len(chosenLocks) > 0 {
				command = append(command, "--frozen-lockfile")
			}
			offline = append(append([]string(nil), command...), "--offline")
		}
		// pnpm's conventional offline order is also used by indexed recipes.
		if manager == "pnpm" && len(chosenLocks) > 0 {
			offline = []string{"pnpm", "install", "--offline", "--frozen-lockfile"}
		}
		install(command, offline, inputs, []string{"registry.npmjs.org", "registry.yarnpkg.com"})
	}
	if data, ok := files["go.mod"]; ok {
		version, field := "", "go.mod"
		seen := map[string]bool{}
		for _, match := range goDirective.FindAllStringSubmatch(string(data), -1) {
			if seen[match[1]] {
				return r, recipeRefusal("go.mod", "duplicate "+match[1]+" directive")
			}
			seen[match[1]] = true
			if match[1] == "go" && version == "" {
				version = match[2]
			}
			if match[1] == "toolchain" && match[2] != "default" {
				version = strings.TrimPrefix(match[2], "go")
				field = "go.mod"
			}
		}
		if version == "" {
			return r, recipeRefusal("go.mod", "missing go directive")
		}
		if err := tool("go", version, field); err != nil {
			return r, err
		}
		install([]string{"go", "mod", "download"}, nil, []string{"go.mod"}, []string{"proxy.golang.org", "sum.golang.org", "storage.googleapis.com"})
	}
	var cargo struct {
		Package struct {
			RustVersion string `toml:"rust-version"`
		} `toml:"package"`
	}
	if data, ok := files["Cargo.toml"]; ok {
		if err := toml.Unmarshal(data, &cargo); err != nil {
			return r, recipeRefusal("Cargo.toml", "invalid TOML: "+err.Error())
		}
	}
	var rust struct {
		Toolchain struct {
			Channel string `toml:"channel"`
		} `toml:"toolchain"`
	}
	if data, ok := files["rust-toolchain.toml"]; ok {
		if err := toml.Unmarshal(data, &rust); err != nil {
			return r, recipeRefusal("rust-toolchain.toml", "invalid TOML: "+err.Error())
		}
		if rust.Toolchain.Channel == "" {
			return r, recipeRefusal("rust-toolchain.toml", "missing toolchain.channel")
		}
	}
	_, hasCargo := files["Cargo.toml"]
	_, hasRust := files["rust-toolchain.toml"]
	if hasCargo || hasRust {
		version, file := cargo.Package.RustVersion, "Cargo.toml"
		if hasRust {
			version, file = rust.Toolchain.Channel, "rust-toolchain.toml"
		} else if version != "" {
			// Cargo's rust-version is a minimum supported version, not a pin.
			if _, _, valid := numericVersion(version); !valid || !numericVersionPattern.MatchString(version) {
				return r, recipeRefusal(file, "expected one numeric minimum Rust version")
			}
			version = ">=" + version
		}
		if version == "" {
			version = "stable"
		}
		if err := tool("rust", version, file); err != nil {
			return r, err
		}
		if hasCargo {
			install([]string{"cargo", "fetch"}, nil, []string{"Cargo.toml", "rust-toolchain.toml"}, []string{"index.crates.io", "static.crates.io"})
		}
	}
	var project struct {
		Project struct {
			RequiresPython string `toml:"requires-python"`
		} `toml:"project"`
	}
	if data, ok := files["pyproject.toml"]; ok {
		if err := toml.Unmarshal(data, &project); err != nil {
			return r, recipeRefusal("pyproject.toml", "invalid TOML: "+err.Error())
		}
	}
	var requirements []string
	for name := range files {
		if matched, _ := path.Match("requirements*.txt", name); matched {
			requirements = append(requirements, name)
		}
	}
	sort.Strings(requirements)
	_, hasProject := files["pyproject.toml"]
	_, hasPython := files[".python-version"]
	_, hasUV := files["uv.lock"]
	if hasProject || hasPython || hasUV || len(requirements) > 0 {
		version, file := project.Project.RequiresPython, "pyproject.toml"
		if hasPython {
			version, file = strings.TrimSpace(string(files[".python-version"])), ".python-version"
		}
		if !hasProject && !hasPython {
			file = "requirements.txt"
			if hasUV {
				file = "uv.lock"
			} else if len(requirements) > 0 {
				file = requirements[0]
			}
		}
		if err := tool("python", version, file); err != nil {
			return r, err
		}
		if hasUV || (hasProject && len(requirements) == 0) {
			if err := tool("uv", "", "uv.lock"); err != nil {
				return r, err
			}
			command := []string{"uv", "sync"}
			if hasUV {
				command = append(command, "--frozen")
			}
			offline := append(append([]string(nil), command...), "--offline")
			install(command, offline, []string{"pyproject.toml", "uv.lock"}, []string{"pypi.org", "files.pythonhosted.org"})
		} else if len(requirements) > 0 {
			command := []string{"python", "-m", "pip", "install"}
			offline := []string{"python", "-m", "pip", "install", "--no-index"}
			for _, name := range requirements {
				command = append(command, "-r", name)
				offline = append(offline, "-r", name)
			}
			install(command, offline, requirements, []string{"pypi.org", "files.pythonhosted.org"})
		}
	}
	return r, nil
}
