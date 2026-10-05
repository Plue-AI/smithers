// Package flowmanifest verifies the host binaries supplied by a Smithers
// distribution. The same registry feeds local and hosted Flow composition.
package flowmanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

const maxManifestBytes = 1 << 20

var expectedFlows = map[string][]string{
	"coding": {"coding/dispatch"},
}

// A native bundle also carries the Linux arm64 workspace helper the backend
// plants into guests (SMITHERS_WORKSPACE_JJ_EXPORT_BINARY). It runs no Flow,
// so it sits outside the host set, but its digest is checked with the hosts.
const (
	linuxHelperFamily     = "jjExport"
	linuxHelperExecutable = "linux-arm64/smithers-jj-export"
)

// Host is a validated packaged executable. Source revision is deliberately
// absent: it belongs to the authorized repository/workspace binding.
type Host struct {
	Executable string
	SHA256     string
	Flows      []string
}

type Registry struct {
	Coding Host
}

type rawManifest struct {
	Version int                `json:"version"`
	Hosts   map[string]rawHost `json:"hosts"`
}

type rawHost struct {
	Executable string   `json:"executable"`
	SHA256     string   `json:"sha256"`
	Flows      []string `json:"flows"`
}

// Load rejects missing, altered, or incomplete host bundles before a worker
// can accept Flow launches. The packaged hosts verify their digest at launch.
func Load(path string) (Registry, error) {
	if !filepath.IsAbs(path) {
		return Registry{}, errors.New("Flow host manifest path must be absolute")
	}
	// Reject special files before opening: opening a FIFO can block forever
	// before the descriptor-level validation below gets a chance to run.
	info, err := os.Stat(path)
	if err != nil {
		return Registry{}, fmt.Errorf("stat Flow host manifest: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxManifestBytes {
		return Registry{}, errors.New("Flow host manifest must be a regular file under 1 MiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return Registry{}, fmt.Errorf("open Flow host manifest: %w", err)
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxManifestBytes {
		return Registry{}, errors.New("Flow host manifest must be a regular file under 1 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxManifestBytes+1))
	if err != nil {
		return Registry{}, fmt.Errorf("read Flow host manifest: %w", err)
	}
	return Parse(data, filepath.Dir(path))
}

// Parse decodes a Flow host manifest's bytes, whose hosts sit in directory,
// and verifies those hosts as Load does. A caller that verified the bytes
// itself (the installed bundle's pinned manifest) parses exactly them.
func Parse(data []byte, directory string) (Registry, error) {
	if !filepath.IsAbs(directory) || len(data) > maxManifestBytes {
		return Registry{}, errors.New("Flow host manifest must be under 1 MiB beside absolute hosts")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var raw rawManifest
	if err := decoder.Decode(&raw); err != nil {
		return Registry{}, fmt.Errorf("decode Flow host manifest: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Registry{}, errors.New("Flow host manifest contains trailing data")
	}
	hosts := make(map[string]rawHost, len(raw.Hosts))
	for family, entry := range raw.Hosts {
		hosts[family] = entry
	}
	if helper, ok := hosts[linuxHelperFamily]; ok {
		delete(hosts, linuxHelperFamily)
		if helper.Executable != linuxHelperExecutable {
			return Registry{}, fmt.Errorf("%s helper must be %s", linuxHelperFamily, linuxHelperExecutable)
		}
		if len(helper.Flows) != 0 {
			return Registry{}, fmt.Errorf("%s Flow host declares unexpected flows", linuxHelperFamily)
		}
		helperPath := filepath.Join(directory, filepath.FromSlash(linuxHelperExecutable))
		if err := verifyExecutable(helperPath, linuxHelperFamily, helper.SHA256); err != nil {
			return Registry{}, err
		}
	}
	if raw.Version != 1 || len(hosts) != len(expectedFlows) {
		return Registry{}, errors.New("Flow host manifest has unsupported version or host set")
	}
	var registry Registry
	for family, wanted := range expectedFlows {
		entry, ok := hosts[family]
		if !ok {
			return Registry{}, fmt.Errorf("Flow host manifest lacks %s", family)
		}
		host, err := verifyHost(directory, family, entry, wanted)
		if err != nil {
			return Registry{}, err
		}
		registry.Coding = host
	}
	return registry, nil
}

func verifyHost(directory, family string, entry rawHost, wanted []string) (Host, error) {
	name := entry.Executable
	if name == "" || name == "." || filepath.Base(name) != name || strings.ContainsAny(name, "/\\\x00") {
		return Host{}, fmt.Errorf("%s Flow host executable is not a bundle basename", family)
	}
	flows := append([]string(nil), entry.Flows...)
	sort.Strings(flows)
	if !reflect.DeepEqual(flows, wanted) {
		return Host{}, fmt.Errorf("%s Flow host declares unexpected flows", family)
	}
	path := filepath.Join(directory, name)
	if err := verifyExecutable(path, family, entry.SHA256); err != nil {
		return Host{}, err
	}
	return Host{Executable: path, SHA256: entry.SHA256, Flows: flows}, nil
}

// verifyExecutable checks that path is a nonempty executable regular file,
// not a symlink, whose SHA-256 is want.
func verifyExecutable(path, family, want string) error {
	if len(want) != 64 || want != strings.ToLower(want) {
		return fmt.Errorf("%s Flow host digest is invalid", family)
	}
	if _, err := hex.DecodeString(want); err != nil {
		return fmt.Errorf("%s Flow host digest is invalid: %w", family, err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat %s Flow host: %w", family, err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s Flow host is not an executable regular file", family)
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s Flow host: %w", family, err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return fmt.Errorf("hash %s Flow host: %w", family, err)
	}
	if hex.EncodeToString(digest.Sum(nil)) != want {
		return fmt.Errorf("%s Flow host checksum differs from manifest", family)
	}
	return nil
}
