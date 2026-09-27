package microsandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Environments are layered, content-addressed microVM disks:
//
//	L0 image        pinned OCI reference
//	L1 toolchain    the repository's declared toolchain pins, each fetched
//	                against a reviewed checksum
//	L2 dependencies the build graph's install nodes (.smithers/target-index.json
//	                rules Install, Go.ModDownload and the Cargo inputs) keyed by
//	                the content of their declared inputs; caches only, outside
//	                the workspace root
//	L3 source       the product checkout plus an offline link, per workspace
//
// Each layer's key is a SHA-256 over its parent's key and its declared
// inputs, so a change invalidates exactly the layers whose inputs changed.
// Layers are Microsandbox snapshots (APFS clones), built once in a prepare VM
// with a per-layer network allowlist and verified in a fresh offline VM.

const (
	layerSchema     = "smithers.microvm.layer/v1"
	layerToolchain  = "toolchain"
	layerDependency = "dependencies"
	layerMarkerDir  = "/opt/smithers/layers"
	cacheRoot       = "/var/cache/smithers"
	toolchainRoot   = "/opt/smithers/toolchain"
	// toolHome holds what tool nodes download into $HOME (for example
	// ~/.hutch); workspaces link its entries into the agent's home.
	toolHome = cacheRoot + "/home"
)

// EnvironmentConfig enables graph-keyed environment layers.
type EnvironmentConfig struct {
	// Image is the pinned L0 image. Default node:26-bookworm at the digest
	// qualified on this host.
	Image string
	// PrepareCPUs, PrepareMemoryMiB and PrepareDiskMiB shape prepare VMs.
	PrepareCPUs      int
	PrepareMemoryMiB int
	PrepareDiskMiB   int
	// PrepareTimeout is the runaway guard for one layer build (default 60 min).
	PrepareTimeout time.Duration
	// LayerBudgetBytes bounds the allocated bytes of this owner's layer
	// snapshots (default 48 GiB).
	LayerBudgetBytes int64
	// MinFreeBytes is the host free-disk floor below which nothing new is
	// built or booted (default 40 GiB).
	MinFreeBytes int64
	// KeepPerFamily is how many newest layers of one (kind, repository) are
	// kept even when unreferenced (default 2).
	KeepPerFamily int
}

func (c *EnvironmentConfig) defaults() {
	if c.Image == "" {
		c.Image = DefaultImage
	}
	if c.PrepareCPUs <= 0 {
		c.PrepareCPUs = 6
	}
	if c.PrepareMemoryMiB <= 0 {
		c.PrepareMemoryMiB = 12288
	}
	if c.PrepareDiskMiB <= 0 {
		c.PrepareDiskMiB = 49152
	}
	if c.PrepareTimeout <= 0 {
		c.PrepareTimeout = 60 * time.Minute
	}
	if c.LayerBudgetBytes <= 0 {
		c.LayerBudgetBytes = 48 << 30
	}
	if c.MinFreeBytes <= 0 {
		c.MinFreeBytes = 40 << 30
	}
	if c.KeepPerFamily <= 0 {
		c.KeepPerFamily = 2
	}
}

// layerRecord is the adapter's durable index entry for one layer snapshot.
type layerRecord struct {
	Schema     string            `json:"schema"`
	Kind       string            `json:"kind"`
	Key        string            `json:"key"`
	Name       string            `json:"name"`
	ParentKey  string            `json:"parentKey,omitempty"`
	Repository string            `json:"repository,omitempty"`
	Recipe     json.RawMessage   `json:"recipe"`
	Link       []string          `json:"link,omitempty"`
	Inventory  map[string]string `json:"inventory,omitempty"`
	BuildSecs  float64           `json:"buildSeconds"`
	CreatedAt  time.Time         `json:"createdAt"`
	LastUsed   time.Time         `json:"lastUsed"`
}

type environments struct {
	runtime  *Runtime
	config   EnvironmentConfig
	sources  workspaceapi.SourceFiles
	build    sync.Mutex
	mu       sync.Mutex
	verified map[string]bool
}

// BindSourceFiles supplies the product's repository reader. Until it is
// bound, workspaces with a Source are refused rather than booted unprepared.
func (r *Runtime) BindSourceFiles(sources workspaceapi.SourceFiles) {
	if r.environments == nil {
		return
	}
	r.environments.mu.Lock()
	r.environments.sources = sources
	r.environments.mu.Unlock()
}

func (e *environments) layerDir() string { return filepath.Join(e.runtime.root, "layers") }

func (e *environments) recordPath(name string) string {
	return filepath.Join(e.layerDir(), name+".json")
}

func (e *environments) layerName(kind, key string) string {
	short := map[string]string{layerToolchain: "tc", layerDependency: "dp"}[kind]
	return "smthrs-" + short + "-" + strings.TrimPrefix(e.runtime.owner, "smithers-backend-")[:8] + "-" + key[:20]
}

func (e *environments) readRecord(name string) (layerRecord, error) {
	var record layerRecord
	contents, err := os.ReadFile(e.recordPath(name))
	if err != nil {
		return record, err
	}
	return record, json.Unmarshal(contents, &record)
}

func (e *environments) records() ([]layerRecord, error) {
	entries, err := os.ReadDir(e.layerDir())
	if err != nil {
		return nil, err
	}
	var records []layerRecord
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		record, err := e.readRecord(strings.TrimSuffix(entry.Name(), ".json"))
		if err == nil {
			records = append(records, record)
		}
	}
	return records, nil
}

// ResolveWorkspaceLayer returns the dependency layer for the workspace's
// source, building its toolchain and dependency layers when missing.
func (r *Runtime) ResolveWorkspaceLayer(ctx context.Context, spec workspaceapi.WorkspaceSpec) (Layer, error) {
	if r.environments == nil || spec.Source == nil {
		return Layer{}, nil
	}
	return r.environments.resolve(ctx, *spec.Source)
}

func (e *environments) resolve(ctx context.Context, source workspaceapi.WorkspaceSource) (Layer, error) {
	e.mu.Lock()
	sources := e.sources
	e.mu.Unlock()
	if sources == nil {
		return Layer{}, errors.New("the repository reader for environment layers is not bound")
	}
	if strings.TrimSpace(source.Repository) == "" || strings.TrimSpace(source.Revision) == "" {
		return Layer{}, errors.New("workspace source needs a repository and a revision")
	}
	commit, err := sources.ResolveSourceRevision(ctx, source.Repository, source.Revision)
	if err != nil {
		return Layer{}, fmt.Errorf("resolve %s at %s: %w", source.Repository, source.Revision, err)
	}
	if !lowerHex(commit, 40) {
		return Layer{}, fmt.Errorf("repository reader resolved %q, not a commit id", commit)
	}
	source.Revision = commit
	read := func(path string) ([]byte, bool, error) {
		contents, err := sources.ReadSourceFile(ctx, source, path)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, fmt.Errorf("read %s at %s: %w", path, source.Revision[:12], err)
		}
		return contents, true, nil
	}
	toolchain, err := toolchainRecipe(e.config.Image, read)
	if err != nil {
		return Layer{}, err
	}
	toolchainLayer, err := e.ensure(ctx, layerToolchain, toolchain, "", source.Repository, nil)
	if err != nil {
		return Layer{}, err
	}
	dependencies, inputs, err := dependencyRecipe(toolchainLayer.Key, read)
	if err != nil {
		return Layer{}, err
	}
	dependencyLayer, err := e.ensure(ctx, layerDependency, dependencies, toolchainLayer.Key, source.Repository, inputs)
	if err != nil {
		return Layer{}, err
	}
	return Layer{Snapshot: dependencyLayer.Name, Key: dependencyLayer.Key, Link: dependencyLayer.Link}, nil
}

// recipe is one layer's canonical declaration; its digest is the layer key.
type recipe interface {
	kind() string
	script() string
	allowlist() []string
	link() []string
}

func recipeKey(parent string, value recipe) (string, []byte, error) {
	// The key covers the declared inputs and the exact build procedure, so
	// changing how a layer is built invalidates it as surely as its inputs.
	encoded, err := json.Marshal(struct {
		Schema    string   `json:"schema"`
		Kind      string   `json:"kind"`
		Parent    string   `json:"parent"`
		Recipe    recipe   `json:"recipe"`
		Script    string   `json:"script"`
		Allowlist []string `json:"allowlist"`
	}{layerSchema, value.kind(), parent, value, digest(value.script()), value.allowlist()})
	if err != nil {
		return "", nil, err
	}
	return digest(string(encoded)), encoded, nil
}

// ensure returns a verified layer, building it once when it does not exist.
func (e *environments) ensure(ctx context.Context, kind string, value recipe, parentKey, repository string, inputs map[string][]byte) (layerRecord, error) {
	key, encoded, err := recipeKey(parentKey, value)
	if err != nil {
		return layerRecord{}, err
	}
	name := e.layerName(kind, key)
	if record, ok := e.usable(ctx, name); ok {
		return record, nil
	}
	e.build.Lock()
	defer e.build.Unlock()
	if record, ok := e.usable(ctx, name); ok {
		return record, nil
	}
	if err := e.admit(ctx); err != nil {
		return layerRecord{}, err
	}
	parent := ""
	if parentKey != "" {
		parent = e.layerName(layerToolchain, parentKey)
		// A dependency layer starts from the newest dependency layer of the same
		// repository and toolchain, so its stores are only topped up.
		if warm := e.newestSibling(kind, repository, parentKey); warm != "" {
			parent = warm
		}
	}
	record := layerRecord{Schema: layerSchema, Kind: kind, Key: key, Name: name, ParentKey: parentKey, Repository: repository,
		Recipe: encoded, Link: value.link()}
	started := time.Now()
	inventory, err := e.buildLayer(ctx, record, value, parent, inputs)
	if err != nil {
		return layerRecord{}, err
	}
	record.Inventory = inventory
	record.BuildSecs = time.Since(started).Seconds()
	record.CreatedAt = time.Now().UTC()
	record.LastUsed = record.CreatedAt
	if err := os.MkdirAll(e.layerDir(), 0o700); err != nil {
		return layerRecord{}, err
	}
	if err := writeJSON(e.recordPath(name), record); err != nil {
		return layerRecord{}, err
	}
	if err := e.verify(ctx, record); err != nil {
		_ = e.removeLayer(context.Background(), name)
		return layerRecord{}, err
	}
	if _, err := e.collect(ctx); err != nil {
		return layerRecord{}, fmt.Errorf("layer garbage collection: %w", err)
	}
	return record, nil
}

// usable returns a layer whose record and snapshot both exist and which has
// been verified in this process.
func (e *environments) usable(ctx context.Context, name string) (layerRecord, bool) {
	record, err := e.readRecord(name)
	if err != nil {
		return layerRecord{}, false
	}
	if _, found, err := e.snapshot(ctx, name); err != nil || !found {
		_ = os.Remove(e.recordPath(name))
		return layerRecord{}, false
	}
	e.mu.Lock()
	verified := e.verified[name]
	e.mu.Unlock()
	if !verified && e.verify(ctx, record) != nil {
		_ = e.removeLayer(context.Background(), name)
		return layerRecord{}, false
	}
	record.LastUsed = time.Now().UTC()
	_ = writeJSON(e.recordPath(name), record)
	return record, true
}

func (e *environments) snapshot(ctx context.Context, name string) (snapshotRecord, bool, error) {
	records, err := e.runtime.cli.listSnapshots(ctx)
	if err != nil {
		return snapshotRecord{}, false, err
	}
	for _, record := range records {
		if record.Name != nil && *record.Name == name {
			return record, true, nil
		}
	}
	return snapshotRecord{}, false, nil
}

func (e *environments) newestSibling(kind, repository, parentKey string) string {
	records, err := e.records()
	if err != nil {
		return ""
	}
	var best layerRecord
	for _, record := range records {
		if record.Kind == kind && record.Repository == repository && record.ParentKey == parentKey && record.CreatedAt.After(best.CreatedAt) {
			best = record
		}
	}
	return best.Name
}

// buildLayer boots a prepare VM from the parent (image or snapshot) with the
// layer's network allowlist, runs its recipe as root, records the inventory,
// flushes, stops, and captures the disk as the layer snapshot.
func (e *environments) buildLayer(ctx context.Context, record layerRecord, value recipe, parent string, inputs map[string][]byte) (map[string]string, error) {
	buildCtx, cancel := context.WithTimeout(ctx, e.config.PrepareTimeout)
	defer cancel()
	machine := "smthrs-prep-" + strings.TrimPrefix(e.runtime.owner, "smithers-backend-")[:8] + "-" + newExecID()[1:13]
	args := []string{"-n", machine, "-c", strconv.Itoa(e.config.PrepareCPUs), "-m", strconv.Itoa(e.config.PrepareMemoryMiB) + "M", "-q",
		"--no-net", "--net-rule", "allow@dns",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + e.runtime.owner,
		"--label", holderLabel + "=" + e.runtime.holder, "--label", layerLabel + "=prepare"}
	for _, domain := range value.allowlist() {
		args = append(args, "--net-rule", "allow@"+domain)
	}
	if parent == "" {
		args = append([]string{"create", e.config.Image, "--pull", "if-missing", "--root-disk", strconv.Itoa(e.config.PrepareDiskMiB) + "M"}, args...)
	} else {
		args = append([]string{"run", "--from-snapshot", parent, "-d"}, args...)
	}
	if _, err := e.runtime.cli.run(buildCtx, nil, args...); err != nil {
		return nil, fmt.Errorf("%w: boot prepare VM: %v", ErrUnavailable, err)
	}
	defer func() { _ = e.runtime.removeMachine(context.Background(), machine) }()
	if err := e.runtime.installGuest(buildCtx, machine); err != nil {
		return nil, err
	}
	if _, err := e.runtime.guest(buildCtx, machine, nil, "setup", guestUser, strconv.Itoa(guestUID), cacheRoot, layerMarkerDir); err != nil {
		return nil, err
	}
	if len(inputs) > 0 {
		archive, err := tarFiles(inputs)
		if err != nil {
			return nil, err
		}
		plant := "set -e; rm -rf " + cacheRoot + "/prepare; mkdir -p " + cacheRoot + "/prepare/src; tar -x -C " + cacheRoot + "/prepare/src"
		if _, err := e.runtime.cli.run(buildCtx, archive, "exec", machine, "--", "sh", "-c", plant); err != nil {
			return nil, fmt.Errorf("%w: plant layer inputs: %v", ErrUnavailable, err)
		}
	}
	script := value.script() + "\n" + markerScript(record)
	output, err := e.runRoot(buildCtx, machine, script)
	if err != nil {
		return nil, fmt.Errorf("build %s layer %s: %w", record.Kind, record.Key[:12], err)
	}
	inventory := parseInventory(output)
	if _, err := e.runRoot(buildCtx, machine, "sync"); err != nil {
		return nil, err
	}
	if err := e.runtime.stopMachine(buildCtx, machine); err != nil {
		return nil, err
	}
	snapshotArgs := []string{"snapshot", "create", record.Name, "--from", machine, "-q", "--force",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + e.runtime.owner,
		"--label", layerLabel + "=" + record.Kind}
	if _, err := e.runtime.cli.run(buildCtx, nil, snapshotArgs...); err != nil {
		return nil, fmt.Errorf("%w: capture %s layer: %v", ErrUnavailable, record.Kind, err)
	}
	return inventory, nil
}

// runRoot runs a shell script as root through the exec helper and returns
// its stdout, failing with the tail of its output when it exits nonzero.
func (e *environments) runRoot(ctx context.Context, machine, script string) (string, error) {
	request, err := json.Marshal(execRequest{ID: newExecID(), Argv: []string{"/bin/bash", "-c", script}, Cwd: "/", User: "root",
		Env: map[string]string{"HOME": "/root", "TMPDIR": "/var/tmp", "DEBIAN_FRONTEND": "noninteractive"}})
	if err != nil {
		return "", err
	}
	cmd := e.runtime.cli.command(guestArgs(machine, nil, false, "exec")...)
	cmd.Stdin = bytes.NewReader(request)
	stdout := &limitedBuffer{limit: 16 << 20}
	stderr := &limitedBuffer{limit: 16 << 20}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := startCommand(ctx, cmd); err != nil {
		return "", err
	}
	waitErr := waitCommand(ctx, cmd)
	if ctx.Err() != nil {
		return "", fmt.Errorf("%w: prepare exceeded its runaway guard: %v", ErrCommandRunaway, ctx.Err())
	}
	code, ok := stderr.exit()
	out, _ := stdout.text()
	errText, _ := stderr.text()
	if !ok {
		return "", fmt.Errorf("%w: prepare command lost (%v): %s", ErrUnavailable, waitErr, tail(errText))
	}
	if code != 0 {
		return "", fmt.Errorf("exited %d: %s", code, tail(out+errText))
	}
	return out, nil
}

func tail(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 2000 {
		text = "…" + text[len(text)-2000:]
	}
	return text
}

func markerScript(record layerRecord) string {
	marker, _ := json.Marshal(map[string]string{"kind": record.Kind, "key": record.Key, "name": record.Name})
	return fmt.Sprintf("mkdir -p %s && printf '%%s' %s > %s/%s.json", layerMarkerDir, shellQuote(string(marker)), layerMarkerDir, record.Kind)
}

// verify boots a fresh offline VM from the layer and checks its marker: the
// quarry's rule that a captured base must still hold what was prepared.
func (e *environments) verify(ctx context.Context, record layerRecord) error {
	machine := "smthrs-vfy-" + strings.TrimPrefix(e.runtime.owner, "smithers-backend-")[:8] + "-" + newExecID()[1:13]
	args := []string{"run", "--from-snapshot", record.Name, "-d", "-n", machine, "-c", "1", "-m", "1024M", "-q", "--no-net",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + e.runtime.owner, "--label", layerLabel + "=verify"}
	verifyCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if _, err := e.runtime.cli.run(verifyCtx, nil, args...); err != nil {
		return fmt.Errorf("%w: boot layer %s for verification: %v", ErrUnavailable, record.Name, err)
	}
	defer func() { _ = e.runtime.removeMachine(context.Background(), machine) }()
	output, err := e.runtime.cli.run(verifyCtx, nil, "exec", machine, "--", "cat", layerMarkerDir+"/"+record.Kind+".json")
	if err != nil {
		return fmt.Errorf("layer %s holds no marker: %w", record.Name, err)
	}
	var marker map[string]string
	if json.Unmarshal(output, &marker) != nil || marker["key"] != record.Key {
		return fmt.Errorf("layer %s does not hold what was prepared", record.Name)
	}
	e.mu.Lock()
	if e.verified == nil {
		e.verified = map[string]bool{}
	}
	e.verified[record.Name] = true
	e.mu.Unlock()
	return nil
}

func tarFiles(files map[string][]byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(files[name])), Typeflag: tar.TypeReg}); err != nil {
			return nil, err
		}
		if _, err := writer.Write(files[name]); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// parseInventory reads `inventory <tool> <version>` lines a recipe prints.
func parseInventory(output string) map[string]string {
	inventory := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.SplitN(strings.TrimSpace(line), " ", 3)
		if len(fields) == 3 && fields[0] == "inventory" {
			inventory[fields[1]] = fields[2]
		}
	}
	return inventory
}

// ---- L1: toolchain ----

// download is one pinned artifact and its reviewed SHA-256 (linux/arm64).
type download struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

// reviewedDownloads holds the checksums a human verified by download. A
// repository pinning a version absent here is refused, never fetched blind.
var reviewedDownloads = map[string]map[string]download{
	"node":   {"26.5.0": {"https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-arm64.tar.xz", "036df0b49662ebb350eb56f1cac603699b1e9ed1e2603ee129fefda473479030"}},
	"pnpm":   {"11.25.0": {"https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz", "33dd0748f27e7916c4f1c8b6943461983e3453b06bbda6312a6280130b4881e5"}},
	"bun":    {"1.4.1": {"https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-aarch64.zip", "580ce77533108dc6b10bec1721397e4f5aa44e909726da2451d483dfc5e581d6"}},
	"go":     {"1.26.8": {"https://go.dev/dl/go1.26.8.linux-arm64.tar.gz", "211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0"}},
	"jj":     {"0.39.0": {"https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-aarch64-unknown-linux-musl.tar.gz", "15bbb0199adf57929d1e3cd90ae0b47356858cbe374814769815a1fb87d5ad1d"}},
	"rg":     {"14.1.1": {"https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz", "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f"}},
	"fd":     {"10.2.0": {"https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz", "4e8e596646d047d904f2c5ca74b39dccc69978b6e1fb101094e534b0b59c1bb0"}},
	"jq":     {"1.7.1": {"https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64", "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5"}},
	"rustup": {"1.28.2": {"https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-unknown-linux-gnu/rustup-init", "e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c"}},
}

// Profile defaults for tools a repository does not pin as data.
var profileVersions = map[string]string{"node": "26.5.0", "pnpm": "11.25.0", "bun": "1.4.1", "go": "1.26.8", "jj": "0.39.0",
	"rg": "14.1.1", "fd": "10.2.0", "jq": "1.7.1", "rustup": "1.28.2"}

// pgdgKeyFingerprint pins the PostgreSQL apt repository signing key.
const pgdgKeyFingerprint = "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"

type toolchainLayer struct {
	Image     string              `json:"image"`
	Downloads map[string]download `json:"downloads"`
	Versions  map[string]string   `json:"versions"`
	Rust      string              `json:"rust,omitempty"`
	RustParts []string            `json:"rustComponents,omitempty"`
	RustTargs []string            `json:"rustTargets,omitempty"`
	Postgres  string              `json:"postgres"`
}

var (
	nodeVersionPattern = regexp.MustCompile(`^v?([0-9]+\.[0-9]+\.[0-9]+)$`)
	goDirective        = regexp.MustCompile(`(?m)^go ([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$`)
	constantPattern    = func(name string) *regexp.Regexp {
		return regexp.MustCompile(`(?m)export const ` + name + ` = "([0-9]+\.[0-9]+\.[0-9]+)"`)
	}
	tomlString = func(key string) *regexp.Regexp { return regexp.MustCompile(`(?m)^` + key + `\s*=\s*"([^"]+)"`) }
	tomlList   = func(key string) *regexp.Regexp { return regexp.MustCompile(`(?m)^` + key + `\s*=\s*\[([^\]]*)\]`) }
)

// toolchainRecipe reads the repository's declared pins at the revision.
func toolchainRecipe(image string, read func(string) ([]byte, bool, error)) (toolchainLayer, error) {
	versions := map[string]string{}
	for tool, version := range profileVersions {
		versions[tool] = version
	}
	if contents, ok, err := read(".node-version"); err != nil {
		return toolchainLayer{}, err
	} else if ok {
		match := nodeVersionPattern.FindStringSubmatch(strings.TrimSpace(string(contents)))
		if match == nil {
			return toolchainLayer{}, errors.New(".node-version does not name an exact release")
		}
		versions["node"] = match[1]
	}
	if contents, ok, err := read("package.json"); err != nil {
		return toolchainLayer{}, err
	} else if ok {
		var manifest struct {
			PackageManager string `json:"packageManager"`
		}
		if json.Unmarshal(contents, &manifest) == nil && strings.HasPrefix(manifest.PackageManager, "pnpm@") {
			versions["pnpm"] = strings.SplitN(strings.TrimPrefix(manifest.PackageManager, "pnpm@"), "+", 2)[0]
		}
	}
	if contents, ok, err := read("go.mod"); err != nil {
		return toolchainLayer{}, err
	} else if ok {
		if match := goDirective.FindSubmatch(contents); match != nil {
			versions["go"] = string(match[1])
		}
	}
	if contents, ok, err := read(".smithers/WORKSPACE.ts"); err != nil {
		return toolchainLayer{}, err
	} else if ok {
		for tool, constant := range map[string]string{"bun": "bunVersion", "jj": "jjVersion"} {
			if match := constantPattern(constant).FindSubmatch(contents); match != nil {
				versions[tool] = string(match[1])
			}
		}
	}
	layer := toolchainLayer{Image: image, Versions: versions, Downloads: map[string]download{}, Postgres: "18"}
	for tool, version := range versions {
		pinned, ok := reviewedDownloads[tool][version]
		if !ok {
			return toolchainLayer{}, fmt.Errorf("%s %s has no reviewed linux/arm64 checksum; add it to microsandbox reviewedDownloads", tool, version)
		}
		layer.Downloads[tool] = pinned
	}
	if contents, ok, err := read("rust-toolchain.toml"); err != nil {
		return toolchainLayer{}, err
	} else if ok {
		if match := tomlString("channel").FindSubmatch(contents); match != nil {
			layer.Rust = string(match[1])
		}
		layer.RustParts = tomlItems(tomlList("components").FindSubmatch(contents))
		layer.RustTargs = tomlItems(tomlList("targets").FindSubmatch(contents))
	}
	return layer, nil
}

func tomlItems(match [][]byte) []string {
	if match == nil {
		return nil
	}
	var items []string
	for _, item := range strings.Split(string(match[1]), ",") {
		item = strings.Trim(strings.TrimSpace(item), `"'`)
		if item != "" {
			items = append(items, item)
		}
	}
	sort.Strings(items)
	return items
}

func (t toolchainLayer) kind() string   { return layerToolchain }
func (t toolchainLayer) link() []string { return nil }

// Domain rules match the DNS name a connection resolved through, so CDN
// CNAME targets are listed beside the names that alias them (apt, for one,
// connects by the canonical name). apt archives are signature-verified.
var toolDownloadHosts = []string{"github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
	"hutch.blackboard.sh", "electrobun-artifacts.blackboard.sh"}

var (
	debianMirrors  = []string{"deb.debian.org", "debian.map.fastly.net", "debian.map.fastlydns.net"}
	postgresMirror = []string{"www.postgresql.org", "www.mirrors.postgresql.org", "apt.postgresql.org", "dualstack.t.sni.global.fastly.net"}
	playwrightCDN  = []string{"cdn.playwright.dev", "playwright-bkakghazbfe7grc5.z01.azurefd.net", "mr-z01.tm-azurefd.net"}
)

func (t toolchainLayer) allowlist() []string {
	domains := []string{"nodejs.org", "registry.npmjs.org", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
		"go.dev", "dl.google.com", "static.rust-lang.org", "fastly-static.rust-lang.org", "dualstack.k.sni.global.fastly.net"}
	domains = append(domains, debianMirrors...)
	return append(domains, postgresMirror...)
}

func (t toolchainLayer) script() string {
	var s strings.Builder
	fmt.Fprintf(&s, `set -euo pipefail
T=%[1]s; mkdir -p "$T/bin" /var/tmp/dl %[2]s
fetch() { curl -fsSL --retry 4 --retry-all-errors -o "$3" "$1"; echo "$2  $3" | sha256sum -c - >/dev/null; }
`, toolchainRoot, cacheRoot)
	d := t.Downloads
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/node.tar.xz; mkdir -p $T/node; tar -xJf /var/tmp/dl/node.tar.xz -C $T/node --strip-components=1\n", shellQuote(d["node"].URL), d["node"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/pnpm.tgz; mkdir -p $T/pnpm; tar -xzf /var/tmp/dl/pnpm.tgz -C $T/pnpm --strip-components=1; chmod 0755 $T/pnpm/bin/*.cjs; ln -sf $T/pnpm/bin/pnpm.cjs $T/bin/pnpm; ln -sf $T/pnpm/bin/pnpx.cjs $T/bin/pnpx\n", shellQuote(d["pnpm"].URL), d["pnpm"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/bun.zip; python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' /var/tmp/dl/bun.zip /var/tmp/dl/bun; install -m 0755 /var/tmp/dl/bun/*/bun $T/bin/bun\n", shellQuote(d["bun"].URL), d["bun"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/go.tgz; tar -xzf /var/tmp/dl/go.tgz -C $T\n", shellQuote(d["go"].URL), d["go"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/jj.tgz; tar -xzf /var/tmp/dl/jj.tgz -C $T/bin ./jj\n", shellQuote(d["jj"].URL), d["jj"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/rg.tgz; tar -xzf /var/tmp/dl/rg.tgz -C $T/bin --strip-components=1 --wildcards '*/rg'\n", shellQuote(d["rg"].URL), d["rg"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/fd.tgz; tar -xzf /var/tmp/dl/fd.tgz -C $T/bin --strip-components=1 --wildcards '*/fd'\n", shellQuote(d["fd"].URL), d["fd"].SHA256)
	fmt.Fprintf(&s, "fetch %s %s $T/bin/jq; chmod 0755 $T/bin/jq\n", shellQuote(d["jq"].URL), d["jq"].SHA256)
	if t.Rust != "" {
		components := strings.Join(t.RustParts, ",")
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/rustup-init; chmod +x /var/tmp/dl/rustup-init\n", shellQuote(d["rustup"].URL), d["rustup"].SHA256)
		fmt.Fprintf(&s, "export RUSTUP_HOME=/opt/smithers/rust/rustup CARGO_HOME=/opt/smithers/rust/cargo\n/var/tmp/dl/rustup-init -y --no-modify-path --profile minimal --default-toolchain %s", shellQuote(t.Rust))
		if components != "" {
			fmt.Fprintf(&s, " -c %s", shellQuote(components))
		}
		for _, target := range t.RustTargs {
			fmt.Fprintf(&s, " -t %s", shellQuote(target))
		}
		s.WriteString(" >/dev/null\n")
	}
	fmt.Fprintf(&s, `curl -fsSL --retry 4 -o /var/tmp/dl/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
gpg --batch --quiet --show-keys --with-colons /var/tmp/dl/pgdg.asc | grep -q '^fpr:::::::::%[1]s:$'
gpg --batch --quiet --dearmor < /var/tmp/dl/pgdg.asc > /usr/share/keyrings/pgdg.gpg
echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release; echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-%[2]s >/dev/null
rm -rf /var/lib/apt/lists/* /var/tmp/dl
`, pgdgKeyFingerprint, t.Postgres)
	pathEntries := []string{toolchainRoot + "/bin", toolchainRoot + "/node/bin", toolchainRoot + "/go/bin", "/opt/smithers/rust/cargo/bin",
		"/usr/lib/postgresql/" + t.Postgres + "/bin", "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"}
	env := map[string]string{
		"PATH": strings.Join(pathEntries, ":"), "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOFLAGS": "-mod=readonly",
		"GOMODCACHE": cacheRoot + "/gomod", "GOCACHE": cacheRoot + "/gocache", "RUSTUP_HOME": "/opt/smithers/rust/rustup",
		"CARGO_HOME": cacheRoot + "/cargo", "pnpm_config_store_dir": cacheRoot + "/pnpm-store", "pnpm_config_cache_dir": cacheRoot + "/pnpm-cache", "PLAYWRIGHT_BROWSERS_PATH": cacheRoot + "/ms-playwright",
		"COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "CI": "1", "LANG": "C.UTF-8",
	}
	encoded, _ := json.Marshal(env)
	fmt.Fprintf(&s, "printf '%%s' %s > /opt/smithers/env.json\n", shellQuote(string(encoded)))
	// The toolchain's cargo binaries are shared read-only; each build's
	// registry cache lives in the writable dependency cache.
	fmt.Fprintf(&s, "mkdir -p %[1]s/gomod %[1]s/gocache %[1]s/cargo %[1]s/pnpm-store %[1]s/pnpm-cache %[1]s/ms-playwright %[1]s/home; chown -R %[2]d:%[2]d %[1]s\n", cacheRoot, guestUID)
	s.WriteString(`export PATH="` + strings.Join(pathEntries, ":") + `"
echo "inventory node $(node --version)"; echo "inventory pnpm $(pnpm --version)"; echo "inventory bun $(bun --version)"
echo "inventory go $(go version | cut -d' ' -f3)"; echo "inventory jj $(jj --version)"; echo "inventory rg $(rg --version | head -1)"
echo "inventory fd $(fd --version)"; echo "inventory jq $(jq --version)"; echo "inventory git $(git --version)"
echo "inventory python3 $(python3 --version)"; echo "inventory postgres $(postgres --version)"
`)
	if t.Rust != "" {
		s.WriteString(`echo "inventory rustc $(RUSTUP_HOME=/opt/smithers/rust/rustup /opt/smithers/rust/cargo/bin/rustc --version)"
echo "inventory cargo $(RUSTUP_HOME=/opt/smithers/rust/rustup /opt/smithers/rust/cargo/bin/cargo --version)"
`)
	}
	return s.String()
}

// ---- L2: dependencies ----

type dependencyNode struct {
	Label string            `json:"label"`
	Rule  string            `json:"rule"`
	Files map[string]string `json:"files"`
}

type dependencyLayer struct {
	Toolchain  string           `json:"toolchain"`
	Nodes      []dependencyNode `json:"nodes"`
	Tools      []toolNode       `json:"tools,omitempty"`
	Playwright []string         `json:"playwright,omitempty"`
	Derived    bool             `json:"derived,omitempty"`
}

// toolNode is a graph node that materialises a tool from the lockfile and
// downloads what it needs on first run (rule NodeBinary with the lockfile
// among its inputs, such as apps/app's Hutch devkit). Its entry runs once in
// the prepare VM with HOME at the shared tool home, so workspaces find the
// download offline.
type toolNode struct {
	Label   string `json:"label"`
	Package string `json:"package"`
	Entry   string `json:"entry"`
}

type indexTarget struct {
	Label   string `json:"label"`
	Package string `json:"package"`
	Rule    string `json:"rule"`
	Inputs  []struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
	} `json:"inputs"`
}

var patchPattern = regexp.MustCompile(`(?m)^\s+\S.*:\s*['"]?([^'"\s]+\.patch)['"]?\s*$`)

// patchedDependencies lists the patch files a pnpm-workspace.yaml's
// patchedDependencies block names.
func patchedDependencies(workspace []byte) []string {
	var patches []string
	inBlock := false
	for _, line := range strings.Split(string(workspace), "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "patchedDependencies:"):
			inBlock = true
		case inBlock && trimmed != "" && !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t"):
			inBlock = false
		case inBlock:
			if match := patchPattern.FindStringSubmatch(line); match != nil {
				patches = append(patches, match[1])
			}
		}
	}
	sort.Strings(patches)
	return patches
}

func declares(target indexTarget, path string) bool {
	for _, input := range target.Inputs {
		if input.Path == path || input.Path == "//"+path {
			return true
		}
	}
	return false
}

var importerPattern = regexp.MustCompile(`(?m)^  ([^\s#'"][^:\n]*):\s*$`)

// lockImporters lists the workspace member directories a pnpm lockfile's
// importers section names.
func lockImporters(lock []byte) []string {
	text := string(lock)
	start := strings.Index(text, "\nimporters:\n")
	if start < 0 {
		return nil
	}
	section := text[start+len("\nimporters:\n"):]
	if end := strings.Index(section, "\npackages:\n"); end >= 0 {
		section = section[:end]
	}
	var importers []string
	for _, match := range importerPattern.FindAllStringSubmatch(section, -1) {
		importer := strings.Trim(match[1], `'"`)
		if !strings.Contains(importer, "..") && !strings.HasPrefix(importer, "/") {
			importers = append(importers, importer)
		}
	}
	return importers
}

var playwrightPattern = regexp.MustCompile(`(?m)^\s+playwright-core@([0-9]+\.[0-9]+\.[0-9]+):\s*$`)

// dependencyRecipe derives the install nodes from the committed target
// index. A repository without one gets the same node kinds from the
// manifests it has, marked derived.
func dependencyRecipe(toolchainKey string, read func(string) ([]byte, bool, error)) (dependencyLayer, map[string][]byte, error) {
	layer := dependencyLayer{Toolchain: toolchainKey}
	inputs := map[string][]byte{}
	nodes := map[string]*dependencyNode{}
	addFile := func(node *dependencyNode, path string) error {
		path = strings.TrimPrefix(path, "//")
		if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
			return fmt.Errorf("install node %s declares an invalid input %q", node.Label, path)
		}
		contents, ok, err := read(path)
		if err != nil {
			return err
		}
		if !ok {
			node.Files[path] = "absent"
			return nil
		}
		node.Files[path] = digest(string(contents))
		inputs[path] = contents
		return nil
	}
	index, ok, err := read(".smithers/target-index.json")
	if err != nil {
		return layer, nil, err
	}
	if ok {
		var targets []indexTarget
		if err := json.Unmarshal(index, &targets); err != nil {
			return layer, nil, fmt.Errorf("decode .smithers/target-index.json: %w", err)
		}
		cargo := &dependencyNode{Label: "cargo", Rule: "Cargo.Fetch", Files: map[string]string{}}
		for _, target := range targets {
			switch {
			case target.Rule == "Install" || target.Rule == "Go.ModDownload":
				node := &dependencyNode{Label: target.Label, Rule: target.Rule, Files: map[string]string{}}
				for _, input := range target.Inputs {
					if input.Path != "" && (input.Kind == "file" || input.Kind == "pnpm-workspace") {
						if err := addFile(node, input.Path); err != nil {
							return layer, nil, err
						}
					}
					// A pnpm workspace's patchedDependencies are inputs of its
					// install: pnpm refuses to fetch without the patch files.
					if input.Kind == "pnpm-workspace" {
						for _, patch := range patchedDependencies(inputs[strings.TrimPrefix(input.Path, "//")]) {
							if err := addFile(node, patch); err != nil {
								return layer, nil, err
							}
						}
					}
				}
				nodes[node.Label] = node
			case target.Rule == "NodeBinary" && declares(target, "pnpm-lock.yaml"):
				node := &dependencyNode{Label: target.Label, Rule: target.Rule, Files: map[string]string{}}
				entry := ""
				for _, input := range target.Inputs {
					if input.Kind != "file" || input.Path == "" {
						continue
					}
					if err := addFile(node, input.Path); err != nil {
						return layer, nil, err
					}
					if entry == "" && (strings.HasSuffix(input.Path, ".mjs") || strings.HasSuffix(input.Path, ".cjs") || strings.HasSuffix(input.Path, ".js")) {
						entry = input.Path
					}
				}
				if entry != "" && target.Package != "" && strings.HasPrefix(entry, target.Package+"/") {
					nodes[node.Label] = node
					layer.Tools = append(layer.Tools, toolNode{Label: target.Label, Package: target.Package, Entry: strings.TrimPrefix(entry, target.Package+"/")})
				}
			case strings.HasPrefix(target.Rule, "Cargo.") || target.Label == "//:nativeFfi":
				for _, input := range target.Inputs {
					base := path.Base(input.Path)
					if input.Kind == "file" && (base == "Cargo.toml" || base == "Cargo.lock" || base == "rust-toolchain.toml") {
						if err := addFile(cargo, input.Path); err != nil {
							return layer, nil, err
						}
					}
				}
			}
		}
		if len(cargo.Files) > 0 {
			nodes[cargo.Label] = cargo
		}
	} else {
		layer.Derived = true
		for label, manifest := range map[string][]string{
			"derived:pnpm":  {"pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "package.json"},
			"derived:go":    {"go.mod", "go.sum"},
			"derived:cargo": {"Cargo.toml", "Cargo.lock"},
		} {
			node := &dependencyNode{Label: label, Rule: map[string]string{"derived:pnpm": "Install", "derived:go": "Go.ModDownload", "derived:cargo": "Cargo.Fetch"}[label], Files: map[string]string{}}
			for _, file := range manifest {
				if err := addFile(node, file); err != nil {
					return layer, nil, err
				}
			}
			if node.Files[manifest[0]] != "absent" {
				nodes[label] = node
			}
		}
	}
	// The pnpm-workspace input kind covers the workspace's member manifests;
	// the lockfile's importers name them, so the install can link offline.
	for _, node := range nodes {
		if node.Rule != "Install" {
			continue
		}
		// pnpm records its hook's checksum in the lockfile and refuses a
		// frozen install without it; the build package's install measure
		// keys on it too.
		for _, hook := range []string{".pnpmfile.cjs", ".pnpmfile.mjs"} {
			if err := addFile(node, hook); err != nil {
				return layer, nil, err
			}
		}
		for _, importer := range lockImporters(inputs["pnpm-lock.yaml"]) {
			if importer == "." {
				continue
			}
			if err := addFile(node, importer+"/package.json"); err != nil {
				return layer, nil, err
			}
		}
	}
	sort.Slice(layer.Tools, func(i, j int) bool { return layer.Tools[i].Label < layer.Tools[j].Label })
	labels := make([]string, 0, len(nodes))
	for label := range nodes {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	for _, label := range labels {
		layer.Nodes = append(layer.Nodes, *nodes[label])
	}
	if lock, ok := inputs["pnpm-lock.yaml"]; ok {
		seen := map[string]bool{}
		for _, match := range playwrightPattern.FindAllSubmatch(lock, -1) {
			if version := string(match[1]); !seen[version] {
				seen[version] = true
				layer.Playwright = append(layer.Playwright, version)
			}
		}
		sort.Strings(layer.Playwright)
	}
	return layer, inputs, nil
}

func (d dependencyLayer) kind() string { return layerDependency }

func (d dependencyLayer) has(rule string) bool {
	for _, node := range d.Nodes {
		if node.Rule == rule {
			return true
		}
	}
	return false
}

func (d dependencyLayer) link() []string {
	if d.has("Install") {
		return []string{"pnpm", "install", "--offline", "--frozen-lockfile"}
	}
	return nil
}

func (d dependencyLayer) allowlist() []string {
	domains := []string{"registry.npmjs.org"}
	if d.has("Go.ModDownload") {
		domains = append(domains, "proxy.golang.org", "sum.golang.org", "storage.googleapis.com")
	}
	if d.has("Cargo.Fetch") {
		domains = append(domains, "index.crates.io", "fastly-index.crates.io", "static.crates.io", "fastly-static.crates.io",
			"dualstack.k.sni.global.fastly.net", "crates.io", "github.com", "codeload.github.com")
	}
	if len(d.Playwright) > 0 {
		domains = append(append(domains, playwrightCDN...), debianMirrors...)
	}
	if len(d.Tools) > 0 {
		// Tool nodes do not yet declare their download hosts in the target
		// graph; these are the Hutch/Electrobun release hosts apps/app's
		// devkit needs (tracked: declare network destinations on fetch nodes).
		domains = append(domains, toolDownloadHosts...)
	}
	return domains
}

func (d dependencyLayer) script() string {
	var s strings.Builder
	fmt.Fprintf(&s, `set -eEuo pipefail
exec 3>&1 4>&2 >>/var/tmp/layer.log 2>&1
trap 'tail -60 /var/tmp/layer.log >&4' ERR
set -a; eval "$(python3 -c 'import json,shlex; [print(k+"="+shlex.quote(v)) for k,v in json.load(open("/opt/smithers/env.json")).items()]')"; set +a
cd %s/prepare/src
`, cacheRoot)
	if d.has("Install") {
		// The offline install proves the store is complete for the lockfile
		// and gives tool nodes the packages they run from.
		s.WriteString("pnpm fetch --reporter=append-only\npnpm install --offline --frozen-lockfile --ignore-scripts --reporter=append-only\necho \"inventory pnpm-store $(du -sh $pnpm_config_store_dir | cut -f1)\" >&3\n")
	}
	for _, tool := range d.Tools {
		// Tool downloads through the domain allowlist fail now and then with
		// ConnectionRefused where curl to the same URL succeeds; a new attempt
		// passes. Three attempts, then the build fails with the tool's words.
		fmt.Fprintf(&s, "for attempt in 1 2 3; do (cd %s && HOME=%s node %s) && break; [ $attempt = 3 ] && exit 1; sleep 5; done\n",
			shellQuote(tool.Package), toolHome, shellQuote(tool.Entry))
	}
	if len(d.Tools) > 0 {
		fmt.Fprintf(&s, "echo \"inventory tool-home $(du -sh %s | cut -f1)\" >&3\n", toolHome)
	}
	for _, version := range d.Playwright {
		// Outside the workspace tree, so npx fetches this exact release rather
		// than resolving a workspace binary.
		fmt.Fprintf(&s, "(mkdir -p /var/tmp/playwright && cd /var/tmp/playwright && npx --yes playwright@%s install --with-deps chromium)\n", version)
	}
	if len(d.Playwright) > 0 {
		s.WriteString("rm -rf /var/lib/apt/lists/* /root/.npm\necho \"inventory browsers $(ls $PLAYWRIGHT_BROWSERS_PATH | tr '\\n' ' ')\" >&3\n")
	}
	if d.has("Go.ModDownload") {
		s.WriteString("GOPROXY=https://proxy.golang.org GOFLAGS=-mod=mod go mod download\necho \"inventory gomod $(du -sh $GOMODCACHE | cut -f1)\" >&3\n")
	}
	if d.has("Cargo.Fetch") {
		// cargo reads each workspace member's manifest and needs a target.
		s.WriteString(`for manifest in $(find . -name Cargo.toml -not -path ./Cargo.toml); do dir=$(dirname "$manifest"); mkdir -p "$dir/src"; touch "$dir/src/lib.rs" "$dir/src/main.rs"; done
RUSTUP_HOME=/opt/smithers/rust/rustup cargo fetch --locked
echo "inventory cargo-registry $(du -sh $CARGO_HOME | cut -f1)" >&3
`)
	}
	fmt.Fprintf(&s, "cd /; rm -rf %[1]s/prepare /var/tmp/layer.log; chown -R %[2]d:%[2]d %[1]s\nexec 1>&3\n", cacheRoot, guestUID)
	return s.String()
}

// LinkWorkspaceEnvironment finishes the dependency layer after the product
// checkout: it links node_modules from the layer's store, offline.
func (r *Runtime) LinkWorkspaceEnvironment(ctx context.Context, workspaceID string) error {
	r.mu.Lock()
	ws, err := r.workspaceLocked(workspaceID)
	var link []string
	if err == nil {
		link = append([]string(nil), ws.Link...)
	}
	r.mu.Unlock()
	if err != nil || len(link) == 0 {
		return err
	}
	result, err := r.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{Args: link})
	if err != nil {
		return fmt.Errorf("link workspace environment: %w", err)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("link workspace environment exited %d: %s", result.ExitCode, tail(result.Stdout+result.Stderr))
	}
	return nil
}

var (
	_ workspaceapi.SourceFilesBinder          = (*Runtime)(nil)
	_ workspaceapi.WorkspaceEnvironmentLinker = (*Runtime)(nil)
)
