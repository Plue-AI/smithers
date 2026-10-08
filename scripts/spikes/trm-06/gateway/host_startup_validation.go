package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type hostStartupSample struct {
	PID         int      `json:"pid"`
	Revision    string   `json:"revision"`
	Environment []string `json:"environment"`
}

// Start the actual installed shell entry, loader and gateway. The child waits
// after authority validation so a separate OS process can sample its UID and
// executable command. No child-supplied runtime constant defines an expectation.
func validateInstalledHostStartup(ctx context.Context, a *installedAuthority, evidence string) error {
	if err := a.recheck(); err != nil {
		return err
	}
	names := make([]string, 0, len(startupEnvironmentPoisons))
	for name := range startupEnvironmentPoisons {
		names = append(names, name)
	}
	sort.Strings(names)
	names = append([]string{"positive"}, append(names, "all")...)
	for _, name := range names {
		if err := a.recheck(); err != nil {
			return err
		}
		directory, err := rootScenarioEvidence(evidence, "host-startup-"+name)
		if err != nil {
			return err
		}
		control, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = hostStartupControl(control, a.bundle.Path("share/trm06/run.sh"), a.bundle.Revision(), directory, name)
		cancel()
		if err != nil {
			return fmt.Errorf("host startup %s: %w", name, err)
		}
	}
	return nil
}

func hostStartupControl(ctx context.Context, entry, revision, evidence, name string) (result error) {
	command := exec.CommandContext(ctx, "/bin/sh", entry, "startup-validation")
	command.Dir = "/"
	values := map[string]string{"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
	if name == "all" {
		for key, value := range startupEnvironmentPoisons {
			values[key] = value
		}
	} else if name != "positive" {
		value, exists := startupEnvironmentPoisons[name]
		if !exists {
			return errAuthority
		}
		values[name] = value
	}
	for key, value := range values {
		command.Env = append(command.Env, key+"="+value)
	}
	sort.Strings(command.Env)
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := os.OpenFile(filepath.Join(evidence, "stderr.raw"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer stderr.Close()
	command.Stderr = stderr
	if err = command.Start(); err != nil {
		return err
	}
	defer func() {
		input.Close()
		result = errors.Join(result, command.Wait())
	}()
	// A newline-terminated sample must precede waiting for the parent's release.
	var line []byte
	var one [1]byte
	for len(line) <= 4096 {
		if _, err = io.ReadFull(output, one[:]); err != nil {
			break
		}
		line = append(line, one[0])
		if one[0] == '\n' {
			break
		}
	}
	if saveErr := os.WriteFile(filepath.Join(evidence, "startup.raw"), line, 0600); saveErr != nil {
		return errors.Join(err, saveErr)
	}
	if err != nil {
		return err
	}
	var sample hostStartupSample
	if decodeStrict(line, &sample) != nil || sample.PID != command.Process.Pid || sample.Revision != revision ||
		len(sample.Environment) != 1 || sample.Environment[0] != "PATH=/usr/bin:/bin:/usr/sbin:/sbin" {
		return errors.New("installed host startup identity/environment mismatch")
	}
	observer := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(command.Process.Pid), "-o", "uid=,command=")
	observer.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
	observer.Dir = "/"
	raw, observeErr := observer.CombinedOutput()
	if saveErr := os.WriteFile(filepath.Join(evidence, "process.raw"), raw, 0600); saveErr != nil {
		return errors.Join(observeErr, saveErr)
	}
	fields := strings.Fields(string(raw))
	if observeErr != nil || len(fields) < 2 || fields[0] != strconv.Itoa(os.Getuid()) || !strings.Contains(string(raw), "check-startup") {
		return errors.Join(observeErr, errors.New("independent installed host process identity unavailable"))
	}
	_, err = input.Write([]byte{1})
	return err
}
