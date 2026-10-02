package microsandbox

import (
	"path"
	"regexp"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

var missingToolFiles = map[string]string{
	"node": ".node-version", "pnpm": "package.json", "npm": "package.json", "yarn": "package.json", "bun": "package.json",
	"go": "go.mod", "cargo": "rust-toolchain.toml", "python": ".python-version", "uv": "pyproject.toml",
}

var shellMissingTool = regexp.MustCompile(`(?:^|\n)(?:[^\n]*: )?(node|pnpm|npm|yarn|bun|go|cargo|python|uv): (?:command )?not found(?:\r?\n|$)`)

// MissingToolError preserves unrelated process exits. A shell's exit 127 is
// attributed to a tool only when its stderr names that missing executable.
func MissingToolError(command workspaceapi.Command, result workspaceapi.CommandResult) error {
	if result.ExitCode != 127 || len(command.Args) == 0 {
		return nil
	}
	tool := path.Base(command.Args[0])
	if tool == "sh" || tool == "bash" {
		match := shellMissingTool.FindStringSubmatch(result.Stderr)
		if len(match) < 2 {
			return nil
		}
		tool = match[1]
	}
	file, known := missingToolFiles[tool]
	if !known {
		return nil
	}
	return &RecipeError{Code: "missing_machine_tool", Class: "user", Message: tool + " isn't installed · add " + file, Fix: "Add " + file}
}
