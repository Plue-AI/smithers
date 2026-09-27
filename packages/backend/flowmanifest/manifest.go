// Package flowmanifest verifies the host binaries supplied by a Smithers
// distribution. The same registry feeds local and hosted Flow composition.
package flowmanifest

import (
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
	// The librarian host is the product gateway; it serves no product flow (#2165).
	"librarian": nil,
}

// Host is a validated packaged executable. Source revision is deliberately
// absent: it belongs to the authorized repository/workspace binding.
type Host struct {
	Executable string
	SHA256     string
	Flows      []string
}

type Registry struct {
	Coding    Host
	Librarian Host
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
	decoder := json.NewDecoder(io.LimitReader(file, maxManifestBytes+1))
	decoder.DisallowUnknownFields()
	var raw rawManifest
	if err := decoder.Decode(&raw); err != nil {
		return Registry{}, fmt.Errorf("decode Flow host manifest: %w", err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Registry{}, errors.New("Flow host manifest contains trailing data")
	}
	if raw.Version != 1 || len(raw.Hosts) != len(expectedFlows) {
		return Registry{}, errors.New("Flow host manifest has unsupported version or host set")
	}
	var registry Registry
	for family, wanted := range expectedFlows {
		entry, ok := raw.Hosts[family]
		if !ok {
			return Registry{}, fmt.Errorf("Flow host manifest lacks %s", family)
		}
		host, err := verifyHost(filepath.Dir(path), family, entry, wanted)
		if err != nil {
			return Registry{}, err
		}
		switch family {
		case "coding":
			registry.Coding = host
		case "librarian":
			registry.Librarian = host
		}
	}
	return registry, nil
}

func verifyHost(directory, family string, entry rawHost, wanted []string) (Host, error) {
	name := entry.Executable
	if name == "" || name == "." || filepath.Base(name) != name || strings.ContainsAny(name, "/\\\x00") {
		return Host{}, fmt.Errorf("%s Flow host executable is not a bundle basename", family)
	}
	if len(entry.SHA256) != 64 || entry.SHA256 != strings.ToLower(entry.SHA256) {
		return Host{}, fmt.Errorf("%s Flow host digest is invalid", family)
	}
	if _, err := hex.DecodeString(entry.SHA256); err != nil {
		return Host{}, fmt.Errorf("%s Flow host digest is invalid: %w", family, err)
	}
	flows := append([]string(nil), entry.Flows...)
	sort.Strings(flows)
	if !reflect.DeepEqual(flows, wanted) {
		return Host{}, fmt.Errorf("%s Flow host declares unexpected flows", family)
	}
	path := filepath.Join(directory, name)
	info, err := os.Lstat(path)
	if err != nil {
		return Host{}, fmt.Errorf("stat %s Flow host: %w", family, err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Mode().Perm()&0o111 == 0 {
		return Host{}, fmt.Errorf("%s Flow host is not an executable regular file", family)
	}
	file, err := os.Open(path)
	if err != nil {
		return Host{}, fmt.Errorf("open %s Flow host: %w", family, err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return Host{}, fmt.Errorf("hash %s Flow host: %w", family, err)
	}
	if hex.EncodeToString(digest.Sum(nil)) != entry.SHA256 {
		return Host{}, fmt.Errorf("%s Flow host checksum differs from manifest", family)
	}
	return Host{Executable: path, SHA256: entry.SHA256, Flows: flows}, nil
}
