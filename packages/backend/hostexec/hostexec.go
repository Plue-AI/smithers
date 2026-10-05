// Package hostexec starts the programs the backend runs on its host. Each
// runs by an absolute path, never by name through PATH: git from one
// configured path, every other tool from a fixed system directory. Each gets
// an environment built here, never the backend's inherited one.
//
// Beside an installed bundle, startup configures git as the bundle's verified
// bin/git and the base environment as the one the backend built from its
// allowlist (spec §17.3). Unconfigured (hosted deployments, tests), git is the
// one PATH named when it was first needed, and the base environment is the
// process environment without any GIT_*, DYLD_* or LD_* variable.
package hostexec

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// Config is the process-wide host execution configuration.
type Config struct {
	// Git is git's absolute path.
	Git string
	// GitExecPath and GitTemplateDir are the directories git reads its
	// helper programs and repository templates from; empty leaves git's own.
	GitExecPath, GitTemplateDir string
	// Environment is the base environment of every child, NAME=value. It
	// names no GIT_*, DYLD_* or LD_* variable.
	Environment []string
}

var (
	mu         sync.Mutex
	configured *Config
	lookedUp   string
)

// Configure sets the configuration every later child uses. restore puts the
// previous one back, for tests.
func Configure(config Config) (restore func(), err error) {
	if !filepath.IsAbs(config.Git) {
		return nil, fmt.Errorf("git must be an absolute path: %q", config.Git)
	}
	for _, directory := range []string{config.GitExecPath, config.GitTemplateDir} {
		if directory != "" && !filepath.IsAbs(directory) {
			return nil, fmt.Errorf("git directories must be absolute: %q", directory)
		}
	}
	for _, entry := range config.Environment {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || name == "" {
			return nil, fmt.Errorf("invalid environment entry %q", entry)
		}
		if Injected(name) {
			return nil, fmt.Errorf("the base environment names %s", name)
		}
	}
	copied := config
	copied.Environment = append([]string(nil), config.Environment...)
	mu.Lock()
	previous := configured
	configured = &copied
	mu.Unlock()
	return func() {
		mu.Lock()
		configured = previous
		mu.Unlock()
	}, nil
}

// Injected reports whether a variable can change what a child loads or runs
// without being named on its command line: the dynamic loader's variables
// and git's.
func Injected(name string) bool {
	return strings.HasPrefix(name, "GIT_") || strings.HasPrefix(name, "DYLD_") || strings.HasPrefix(name, "LD_")
}

// current answers the configuration in force.
func current() (Config, error) {
	mu.Lock()
	defer mu.Unlock()
	if configured != nil {
		return *configured, nil
	}
	if lookedUp == "" {
		path, err := exec.LookPath("git")
		if err != nil {
			return Config{}, err
		}
		if lookedUp, err = filepath.Abs(path); err != nil {
			return Config{}, err
		}
	}
	var environment []string
	for _, entry := range os.Environ() {
		if name, _, _ := strings.Cut(entry, "="); !Injected(name) {
			environment = append(environment, entry)
		}
	}
	return Config{Git: lookedUp, Environment: environment}, nil
}

// Environment answers a copy of the base environment.
func Environment() []string {
	config, _ := current()
	return append([]string(nil), config.Environment...)
}

// Lookup answers one variable of the base environment.
func Lookup(name string) (string, bool) {
	for _, entry := range Environment() {
		if key, value, _ := strings.Cut(entry, "="); key == name {
			return value, true
		}
	}
	return "", false
}

// GitEnvironment answers the environment every git child starts with: the
// base environment, no system or user configuration file, no prompt, and
// the configured helper and template directories.
func GitEnvironment() []string {
	config, _ := current()
	environment := append([]string(nil), config.Environment...)
	environment = append(environment, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0")
	if config.GitExecPath != "" {
		environment = append(environment, "GIT_EXEC_PATH="+config.GitExecPath)
	}
	if config.GitTemplateDir != "" {
		environment = append(environment, "GIT_TEMPLATE_DIR="+config.GitTemplateDir)
	}
	return environment
}

// GitArgv answers git's absolute path and the arguments of a git run with
// args: hooks are pinned off (no backend git run uses a hook), whatever a
// repository's configuration says.
func GitArgv(args ...string) (program string, argv []string, err error) {
	config, err := current()
	if err == nil {
		// A configured git that is gone is no git at all.
		if _, statErr := os.Stat(config.Git); statErr != nil {
			err = &exec.Error{Name: config.Git, Err: exec.ErrNotFound}
		}
	}
	if err != nil {
		return "", nil, fmt.Errorf("locate git: %w", err)
	}
	return config.Git, append([]string{"-c", "core.hooksPath=" + os.DevNull}, args...), nil
}

// Git answers a git command with args, by git's absolute path (also its
// argv[0], so a git built to find its helpers relative to itself never looks
// itself up through PATH), with GitEnvironment. A caller adds variables by appending to Env. When git
// cannot be located the command fails at Start.
func Git(ctx context.Context, args ...string) *exec.Cmd {
	return GitWith(ctx, exec.CommandContext, args...)
}

// GitWith is Git built by command, a constructor with exec.CommandContext's
// signature that a test may wrap.
func GitWith(ctx context.Context, command func(context.Context, string, ...string) *exec.Cmd, args ...string) *exec.Cmd {
	program, argv, err := GitArgv(args...)
	if err != nil {
		cmd := command(ctx, os.DevNull)
		cmd.Err = err
		return cmd
	}
	cmd := command(ctx, program, argv...)
	cmd.Env = GitEnvironment()
	return cmd
}

// Shell is the system shell, for the one backend command that must record
// its own process id before it becomes git (repository maintenance).
const Shell = "/bin/sh"

// systemTools are the host system programs the backend runs, by their fixed
// absolute paths in directories only the operating system writes.
var systemTools = map[string]bool{
	"/bin/ps":          true,
	"/usr/bin/sw_vers": true,
	"/usr/sbin/sysctl": true,
	"/usr/sbin/lsof":   true,
}

// ErrNotSystemTool refuses a program that is not one of the fixed tools.
var ErrNotSystemTool = errors.New("not a fixed system tool")

// SystemEnvironment is a system tool's whole environment.
var SystemEnvironment = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}

// System answers a command running one of the fixed system tools with a
// fixed environment. Any other program fails at Start.
func System(ctx context.Context, program string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, program, args...)
	if !systemTools[program] {
		cmd.Err = fmt.Errorf("%w: %s", ErrNotSystemTool, program)
	}
	cmd.Env = append([]string(nil), SystemEnvironment...)
	return cmd
}
