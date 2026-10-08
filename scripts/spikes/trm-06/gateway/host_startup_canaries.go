package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type hostStartupCanaries struct {
	environment map[string]string
	marker      string
}

func (c hostStartupCanaries) unchanged() error {
	if _, err := os.Lstat(c.marker); !os.IsNotExist(err) {
		return errors.Join(err, errors.New("host startup canary executed"))
	}
	return nil
}

// Real imports, shell startup files and a native library constructor. Positive
// controls execute each source before the installed launcher is tested; missing
// compiler/interpreter support refuses rather than counting inert paths as proof.
// All compilation and controls run as the caller, never through a root helper.
func prepareHostStartupCanaries(ctx context.Context, evidence string) (hostStartupCanaries, error) {
	directory := filepath.Join(evidence, "host-startup-canaries")
	c := hostStartupCanaries{marker: filepath.Join(directory, "executed"), environment: map[string]string{}}
	if err := os.Mkdir(directory, 0700); err != nil {
		return c, err
	}
	write := func(name, body string, mode os.FileMode) error {
		return os.WriteFile(filepath.Join(directory, name), []byte(body), mode)
	}
	python := "import os\nf = os.open(" + strconv.Quote(c.marker) + ", os.O_WRONLY | os.O_CREAT, 0o600)\nos.write(f, b'canary')\nos.close(f)\n"
	for _, name := range []string{"sitecustomize.py", "usercustomize.py", "startup.py"} {
		if err := write(name, python, 0600); err != nil {
			return c, err
		}
	}
	// Quote as shell data, including paths with spaces or apostrophes.
	shell := "umask 077; printf canary > " + "'" + strings.ReplaceAll(c.marker, "'", "'\"'\"'") + "'" + "\n"
	if err := write("startup.sh", shell, 0600); err != nil {
		return c, err
	}
	source := "#include <fcntl.h>\n#include <unistd.h>\n__attribute__((constructor)) static void canary(void) { int f = open(" + strconv.Quote(c.marker) + ", O_WRONLY|O_CREAT|O_EXCL, 0600); if(f >= 0) { write(f, \"canary\", 6); close(f); } }\n"
	if err := write("canary.c", source, 0600); err != nil {
		return c, err
	}
	if err := write("probe.c", "int main(void) { return 0; }\n", 0600); err != nil {
		return c, err
	}
	compiler, library := "/usr/bin/cc", filepath.Join(directory, "canary.so")
	flags := []string{"-shared", "-fPIC"}
	if runtime.GOOS == "darwin" {
		compiler = "/usr/bin/clang"
		library = filepath.Join(directory, "canary.dylib")
		flags = []string{"-dynamiclib"}
	}
	run := func(name, executable string, argv, environment []string) error {
		command := exec.CommandContext(ctx, executable, argv...)
		command.Dir = "/"
		command.Env = append([]string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}, environment...)
		raw, err := command.CombinedOutput()
		return errors.Join(err, os.WriteFile(filepath.Join(directory, name+".raw"), raw, 0600))
	}
	if err := run("compile-library", compiler, append(flags, "-o", library, filepath.Join(directory, "canary.c")), nil); err != nil {
		return c, err
	}
	probe := filepath.Join(directory, "probe")
	if err := run("compile-probe", compiler, []string{"-o", probe, filepath.Join(directory, "probe.c")}, nil); err != nil {
		return c, err
	}
	check := func(name, executable string, argv, environment []string) error {
		if err := run(name, executable, argv, environment); err != nil {
			return err
		}
		info, err := os.Lstat(c.marker)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(c.marker)
		if err != nil || string(body) != "canary" || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
			return errors.Join(err, fmt.Errorf("%s positive canary unavailable", name))
		}
		if err = os.WriteFile(filepath.Join(directory, name+".marker"), body, 0600); err != nil {
			return err
		}
		return os.Remove(c.marker)
	}
	if err := check("import-positive", "/usr/bin/python3", []string{"-c", "pass"}, []string{"PYTHONPATH=" + directory}); err != nil {
		return c, err
	}
	if err := check("shell-positive", "/bin/bash", []string{"-c", "true"}, []string{"BASH_ENV=" + filepath.Join(directory, "startup.sh")}); err != nil {
		return c, err
	}
	load := "LD_PRELOAD"
	if runtime.GOOS == "darwin" {
		load = "DYLD_INSERT_LIBRARIES"
	}
	if err := check("library-positive", probe, nil, []string{load + "=" + library}); err != nil {
		return c, err
	}
	for name, value := range startupEnvironmentPoisons {
		c.environment[name] = value
	}
	for _, name := range []string{"PATH", "HOME", "PYTHONPATH", "PYTHONHOME", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"} {
		c.environment[name] = directory
	}
	for _, name := range []string{"BASH_ENV", "ENV"} {
		c.environment[name] = filepath.Join(directory, "startup.sh")
	}
	c.environment["PYTHONSTARTUP"] = filepath.Join(directory, "startup.py")
	c.environment["LD_PRELOAD"] = library
	c.environment["DYLD_INSERT_LIBRARIES"] = library
	body, err := json.MarshalIndent(c.environment, "", "  ")
	if err != nil {
		return c, err
	}
	if err = os.WriteFile(filepath.Join(directory, "injected-environment.json"), body, 0600); err != nil {
		return c, err
	}
	return c, c.unchanged()
}
