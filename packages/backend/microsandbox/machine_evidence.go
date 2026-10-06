package microsandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"os/exec"
	"path"
	"strings"
	"time"
)

//go:generate bun build ../../smithers/scripts/machine-evidence.ts --target=node --minify --outfile=machine_evidence.js
//go:embed machine_evidence.js
var machineEvidenceJS string

// DetectorVersion includes the installed detector bytes in every layer identity.
var DetectorVersion = fmt.Sprintf("smithers.toolchain-detect/v4/%x", sha256.Sum256([]byte(machineEvidenceJS)))

// RecipeError is an actionable machine preparation or command failure.
type MissingTool struct {
	Name string `json:"name"`
	File string `json:"file"`
}

type RecipeError struct {
	MissingTool *MissingTool `json:"missing_tool,omitempty"`
	Code        string       `json:"code"`
	Class       string       `json:"class"`
	Message     string       `json:"message"`
	Fix         string       `json:"fix,omitempty"`
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
type DetectedCheck struct {
	ID   string   `json:"id"`
	Argv []string `json:"argv"`
}

type Recipe struct {
	Checks          []DetectedCheck         `json:"checks,omitempty"`
	DetectorVersion string                  `json:"detectorVersion"`
	Tools           map[string]DetectedTool `json:"tools"`
	PackageManager  string                  `json:"packageManager,omitempty"`
	Installs        []DetectedInstall       `json:"installs,omitempty"`
}

// DetectRecipe is the data adapter to Checklist.evidence, the single detector.
// The installed runtime uses its approved bundle's Node; standalone callers
// (unit tests and development) use Node from PATH. Repository code is never loaded.
func DetectRecipe(read func(string) ([]byte, bool, error)) (Recipe, error) {
	return detectRecipe(context.Background(), read, "", false)
}

// DetectCheckRecipe shares evidence with machine detection, but a bad machine
// declaration cannot block Source ready while the mirror already holds main.
func DetectCheckRecipe(read func(string) ([]byte, bool, error)) (Recipe, error) {
	return detectRecipe(context.Background(), read, "", true)
}

func detectRecipe(ctx context.Context, read func(string) ([]byte, bool, error), node string, checksOnly bool) (Recipe, error) {
	r := Recipe{DetectorVersion: DetectorVersion, Tools: map[string]DetectedTool{}}
	files := map[string]string{}
	// The reader is revision-bound. Enumeration is data, never a host glob.
	for _, file := range []string{
		".node-version", ".nvmrc", "package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb",
		"Makefile", "setup.py", "pytest.ini", "go.mod", "rust-toolchain.toml", "Cargo.toml", ".python-version", "pyproject.toml", "uv.lock", "requirements.txt", "requirements*.txt",
	} {
		data, exists, err := read(file)
		if err != nil {
			return r, fmt.Errorf("read %s: %w", file, err)
		}
		if !exists {
			continue
		}
		if file != "requirements*.txt" {
			files[file] = string(data)
			continue
		}
		var matches map[string]*string
		if err := json.Unmarshal(data, &matches); err != nil {
			return r, recipeRefusal(file, "invalid requirements file listing")
		}
		for name, contents := range matches {
			matched, _ := path.Match("requirements*.txt", name)
			if contents == nil {
				return r, recipeRefusal(file, "requirements contents must be text")
			}
			if !matched || path.Base(name) != name || strings.ContainsAny(name, "\\\x00") {
				return r, recipeRefusal(file, "invalid requirements filename "+name)
			}
			if prior, ok := files[name]; ok && prior != *contents {
				return r, recipeRefusal(name, "inconsistent contents in requirements listing")
			}
			files[name] = *contents
		}
	}
	if node == "" {
		var err error
		node, err = exec.LookPath("node")
		if err != nil {
			return r, fmt.Errorf("machine evidence needs the installed Node runtime: %w", err)
		}
	}
	input, err := json.Marshal(files)
	if err != nil {
		return r, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	argv := []string{"--input-type=module", "--eval", machineEvidenceJS}
	if checksOnly {
		argv = append(argv, "--", "checks")
	}
	command := exec.CommandContext(ctx, node, argv...)
	command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if err != nil {
		return r, fmt.Errorf("machine evidence: %w", err)
	}
	var result struct {
		Recipe Recipe       `json:"recipe"`
		Error  *RecipeError `json:"error"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		return r, fmt.Errorf("machine evidence response: %w", err)
	}
	if result.Error != nil {
		return r, result.Error
	}
	r = result.Recipe
	r.DetectorVersion = DetectorVersion
	for name, tool := range r.Tools {
		if tool.Version == "" {
			tool.Version = defaultToolVersion(name)
			if !validRequestedVersion(tool.Version) {
				return r, recipeRefusal(tool.File, "invalid bundled default for "+name)
			}
			r.Tools[name] = tool
		}
	}
	return r, nil
}
