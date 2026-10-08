package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// The host gateway remains unprivileged. The owner runs the main-pinned native
// campaign separately in a disposable root fixture. Only its protected,
// same-artifact receipt may satisfy the host replacement controls.
func validateInstalledHostReplacements(ctx context.Context, a *installedAuthority, evidence string) error {
	if err := a.recheck(); err != nil {
		return err
	}
	body, entry, err := a.bundle.Read("share/trm06/host_validation.py", 65536)
	if err != nil {
		return err
	}
	if entry.Mode != 0644 || entry.Stage != "host" {
		return errAuthority
	}
	command := exec.CommandContext(ctx, "/usr/bin/python3", "-I", "-S", "-c", string(body), "--read")
	command.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	command.Dir = "/"
	stdout, err := os.OpenFile(filepath.Join(evidence, "host-replacements.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer stdout.Close()
	stderr, err := os.OpenFile(filepath.Join(evidence, "host-replacements.stderr"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer stderr.Close()
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		return errors.Join(err, errors.New("installed native host replacement receipt unavailable"))
	}
	return a.recheck()
}
