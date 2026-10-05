package microsandbox

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pelletier/go-toml/v2"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// Environments are layered, content-addressed microVM disks:
//
//	L0 image        pinned OCI reference
//	L1 toolchain    the authoritative index or detected recipe: each pinned
//	                artifact fetched against its declared SHA-256
//	L2 dependencies detected installs or build graph nodes (.smithers/target-index.json
//	                rules Install, Go.ModDownload and the Cargo inputs) keyed by
//	                the content of their declared inputs; caches only, outside
//	                the workspace root
//	L3 source       the product checkout plus an offline link, per workspace
//
// Each layer's key is a SHA-256 over its parent's key and its declared
// inputs, so a change invalidates exactly the layers whose inputs changed.
// Layers are Microsandbox snapshots (APFS clones), built once in a prepare VM
// with a network allowlist of exactly the destinations its recipe declares,
// and verified in a fresh offline VM.

const (
	layerSchema     = "smithers.microvm.layer/v3-uid19999-team20000-main-warm-parents"
	layerToolchain  = "toolchain"
	layerDependency = "dependencies"
	layerMarkerDir  = "/var/cache/smithers/layers"
	cacheRoot       = "/var/cache/smithers"
	toolchainRoot   = "/opt/smithers/toolchain"
	// toolHome holds what tool nodes download into $HOME (for example
	// ~/.hutch); workspaces link its entries into the agent's home.
	toolHome = cacheRoot + "/home"
)

// Debian 13 Chromium runtime libraries. This shipped apt command is the only
// privileged part of browser dependency preparation; Playwright runs as agent.
const playwrightSystemPackages = "set -e; apt-get update -qq; apt-get install -y -qq --no-install-recommends libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation fonts-noto-color-emoji; rm -rf /var/lib/apt/lists/*"

// EnvironmentConfig enables recipe-keyed environment layers.
type EnvironmentConfig struct {
	// Image is the pinned L0 image. Default DefaultImage.
	Image string
	// PrepareCPUs, PrepareMemoryMiB and PrepareDiskMiB shape prepare VMs.
	PrepareCPUs      int
	PrepareMemoryMiB int
	PrepareDiskMiB   int
	// PrepareTimeout is the runaway guard for one layer build (default 60 min).
	PrepareTimeout time.Duration
	// LayerBudgetBytes bounds the allocated bytes of this owner's layer
	// snapshots, computed from the host profile.
	LayerBudgetBytes int64
	// MinFreeBytes is the host free-disk floor below which nothing new is
	// built or booted (MinFreeDiskBytes).
	MinFreeBytes int64
	// KeepPerFamily is how many newest layers of one (kind, repository) are
	// kept even when unreferenced (default 2).
	KeepPerFamily int
}

func (c *EnvironmentConfig) defaults() {
	if c.Image == "" {
		c.Image = DefaultImage
	}
	if c.PrepareTimeout <= 0 {
		c.PrepareTimeout = 60 * time.Minute
	}
	if c.KeepPerFamily <= 0 {
		c.KeepPerFamily = 2
	}
}

// layerRecord is the adapter's durable index entry for one layer snapshot.
type layerRecord struct {
	Schema     string `json:"schema"`
	Kind       string `json:"kind"`
	Key        string `json:"key"`
	Name       string `json:"name"`
	ParentKey  string `json:"parentKey,omitempty"`
	Repository string `json:"repository,omitempty"`
	// Main is set when the layer was built for the repository's main commit.
	// Only such a layer warm-starts another build (newestSibling).
	Main      bool              `json:"main,omitempty"`
	Recipe    json.RawMessage   `json:"recipe"`
	Link      []string          `json:"link,omitempty"`
	Inventory map[string]string `json:"inventory,omitempty"`
	BuildSecs float64           `json:"buildSeconds"`
	CreatedAt time.Time         `json:"createdAt"`
	LastUsed  time.Time         `json:"lastUsed"`
}

type environments struct {
	runtime  *Runtime
	config   EnvironmentConfig
	sources  workspaceapi.SourceFiles
	build    sync.Mutex
	eviction sync.Mutex
	mu       sync.Mutex
	verified map[string]bool
	inflight map[string]int
}

// pin protects a layer while it is built, verified or used as a preparation
// parent. Counts also cover nested ensure/verify calls and concurrent readers.
func (e *environments) pin(names ...string) func() {
	// Serialize registration with the collector's final deletion decision.
	// A pin acquired after deletion will make ensure rebuild the absent layer.
	e.eviction.Lock()
	defer e.eviction.Unlock()
	e.mu.Lock()
	if e.inflight == nil {
		e.inflight = map[string]int{}
	}
	for _, name := range names {
		if name != "" {
			e.inflight[name]++
		}
	}
	e.mu.Unlock()
	return func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		for _, name := range names {
			if e.inflight[name] > 1 {
				e.inflight[name]--
			} else {
				delete(e.inflight, name)
			}
		}
	}
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
	if spec.Source == nil {
		return Layer{}, nil
	}
	// A runtime without environment layers cannot certify a machine image.
	if r.environments == nil {
		return Layer{}, fmt.Errorf("%w: this runtime builds no environment layers", ErrUnavailable)
	}
	return r.environments.resolve(ctx, *spec.Source, nil)
}

// resolveWorkspaceLayerForCreate retains prepared snapshots until createFrom
// records the workspace reference. Public resolution remains an unowned read.
func (r *Runtime) resolveWorkspaceLayerForCreate(ctx context.Context, spec workspaceapi.WorkspaceSpec) (Layer, func(), error) {
	var pins []func()
	release := func() {
		for _, unpin := range pins {
			unpin()
		}
	}
	if r.environments == nil || spec.Source == nil {
		return Layer{}, release, nil
	}
	layer, err := r.environments.resolve(ctx, *spec.Source, func(name string) {
		pins = append(pins, r.environments.pin(name))
	})
	if err != nil {
		release()
		return Layer{}, func() {}, err
	}
	return layer, release, nil
}

func (e *environments) resolve(ctx context.Context, source workspaceapi.WorkspaceSource, retain func(string)) (Layer, error) {
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
	mainCommit, err := sources.ResolveSourceRevision(ctx, source.Repository, "main")
	if err != nil {
		return Layer{}, fmt.Errorf("resolve machine additions from main: %w", err)
	}
	if !lowerHex(mainCommit, 40) {
		return Layer{}, fmt.Errorf("repository reader resolved main to %q, not a commit id", mainCommit)
	}
	mainSource := source
	mainSource.Revision = mainCommit
	builtForMain := commit == mainCommit
	mainRead := func(name string) ([]byte, bool, error) {
		contents, err := sources.ReadSourceFile(ctx, mainSource, name)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, fmt.Errorf("read %s at %s: %w", name, mainSource.Revision[:12], err)
		}
		return contents, true, nil
	}
	// M-29: executable artifact pins are reviewed on main, never branch input.
	targets, err := readTargetIndex(mainRead)
	if err != nil {
		return Layer{}, err
	}
	machine, err := ReadMachineJSON(mainRead)
	if err != nil {
		return Layer{}, err
	}
	var detected Recipe
	var toolchain toolchainLayer
	if targets == nil {
		detected, err = DetectRecipe(read)
		if err == nil {
			toolchain, err = toolchainRecipe(e.config.Image, nil, detected)
		}
		if err == nil && len(detected.Tools) == 0 && len(machine.Packages) == 0 {
			return Layer{}, nil
		}
	} else {
		toolchain, err = toolchainRecipe(e.config.Image, targets)
	}
	if err != nil {
		return Layer{}, err
	}
	toolchain.Packages = sortedCopy(machine.Packages)
	toolchainKey, _, err := recipeKey("", toolchain)
	if err != nil {
		return Layer{}, err
	}
	// Keep the toolchain until dependency preparation is complete, including
	// collection at admission to its separate prepare VM.
	defer e.pin(e.layerName(layerToolchain, toolchainKey))()
	if retain != nil {
		retain(e.layerName(layerToolchain, toolchainKey))
	}
	toolchainLayer, err := e.ensure(ctx, layerToolchain, toolchain, "", source.Repository, nil, builtForMain)
	if err != nil {
		return Layer{}, err
	}
	var dependencies dependencyLayer
	var inputs map[string][]byte
	if targets == nil {
		dependencies, inputs, err = dependencyRecipe(toolchainLayer.Key, nil, read, detected)
	} else {
		dependencies, inputs, err = dependencyRecipe(toolchainLayer.Key, targets, read)
	}
	if err != nil {
		return Layer{}, err
	}
	if len(dependencies.Nodes) == 0 {
		return Layer{Snapshot: toolchainLayer.Name, Key: toolchainLayer.Key}, nil
	}
	if retain != nil {
		key, _, err := recipeKey(toolchainLayer.Key, dependencies)
		if err != nil {
			return Layer{}, err
		}
		retain(e.layerName(layerDependency, key))
	}
	dependencyLayer, err := e.ensure(ctx, layerDependency, dependencies, toolchainLayer.Key, source.Repository, inputs, builtForMain)
	if err != nil {
		if targets == nil && !errors.Is(err, ErrUnavailable) && !strings.HasPrefix(err.Error(), "disk budget:") {
			return Layer{}, &RecipeError{Code: "dependency_install_failed", Class: "user", Message: "Dependency install failed; S1 supports public registries only: " + err.Error(), Fix: "Change the dependency manifest or add required packages to .smithers/machine.json"}
		}
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
	user, systemScript := recipePreparation(value)
	encoded, err := json.Marshal(struct {
		Schema          string            `json:"schema"`
		Kind            string            `json:"kind"`
		Parent          string            `json:"parent"`
		Recipe          recipe            `json:"recipe"`
		Script          string            `json:"script"`
		User            string            `json:"user"`
		SystemScript    string            `json:"systemScript"`
		RootEnvironment map[string]string `json:"rootEnvironment"`
		Allowlist       []string          `json:"allowlist"`
	}{layerSchema, value.kind(), parent, value, digest(value.script()), user, digest(systemScript), preparationEnvironment("root", "/root"), value.allowlist()})
	if err != nil {
		return "", nil, err
	}
	return digest(string(encoded)), encoded, nil
}

func recipePreparation(value recipe) (user, systemScript string) {
	if toolchain, ok := value.(toolchainLayer); ok {
		return guestUser, toolchain.systemScript()
	}
	return guestUser, ""
}

// ensure returns a verified layer, building it once when it does not exist.
// main records that the build is for the repository's main commit.
func (e *environments) ensure(ctx context.Context, kind string, value recipe, parentKey, repository string, inputs map[string][]byte, main bool) (layerRecord, error) {
	key, encoded, err := recipeKey(parentKey, value)
	if err != nil {
		return layerRecord{}, err
	}
	name := e.layerName(kind, key)
	parentName := ""
	if parentKey != "" {
		parentName = e.layerName(layerToolchain, parentKey)
	}
	defer e.pin(name, parentName)()
	if record, ok, err := e.usable(ctx, name); err != nil {
		return layerRecord{}, err
	} else if ok {
		return record, nil
	}
	e.build.Lock()
	defer e.build.Unlock()
	if record, ok, err := e.usable(ctx, name); err != nil {
		return layerRecord{}, err
	} else if ok {
		return record, nil
	}
	if err := e.admit(ctx); err != nil {
		return layerRecord{}, err
	}
	parent := ""
	if parentKey != "" {
		parent = e.layerName(layerToolchain, parentKey)
		// A dependency layer starts from the newest main-built dependency layer
		// of the same repository and toolchain, so its stores are only topped up.
		if warm := e.newestSibling(kind, repository, parentKey); warm != "" {
			parent = warm
			defer e.pin(warm)()
		}
	}
	record := layerRecord{Schema: layerSchema, Kind: kind, Key: key, Name: name, ParentKey: parentKey, Repository: repository,
		Main: main, Recipe: encoded, Link: value.link()}
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
		var temporary *layerAdmissionError
		if !errors.As(err, &temporary) {
			_ = e.removeLayer(context.Background(), name)
		}
		return layerRecord{}, err
	}
	if _, err := e.collect(ctx); err != nil {
		return layerRecord{}, fmt.Errorf("layer garbage collection: %w", err)
	}
	return record, nil
}

// usable returns a layer whose record and snapshot both exist and which has
// been verified in this process.
// layerAdmissionError marks temporary admission, transport or cleanup failures;
// none proves that a snapshot is corrupt.
type layerAdmissionError struct{ error }

func (e *layerAdmissionError) Unwrap() error { return e.error }

func (e *environments) usable(ctx context.Context, name string) (layerRecord, bool, error) {
	record, err := e.readRecord(name)
	if err != nil {
		return layerRecord{}, false, nil
	}
	if _, found, err := e.snapshot(ctx, name); err != nil {
		return layerRecord{}, false, err
	} else if !found {
		_ = os.Remove(e.recordPath(name))
		return layerRecord{}, false, nil
	}
	e.mu.Lock()
	verified := e.verified[name]
	e.mu.Unlock()
	if !verified {
		if err := e.verify(ctx, record); err != nil {
			var temporary *layerAdmissionError
			if errors.As(err, &temporary) {
				return layerRecord{}, false, err
			}
			_ = e.removeLayer(context.Background(), name)
			return layerRecord{}, false, nil
		}
	}
	record.LastUsed = time.Now().UTC()
	_ = writeJSON(e.recordPath(name), record)
	return record, true, nil
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

// newestSibling returns the newest layer of one kind, repository and parent
// that was built for main. A branch-built layer never warm-starts a build: its
// caches (for example wheels in PIP_FIND_LINKS) would carry one member's build
// outputs into main's and other members' machines.
func (e *environments) newestSibling(kind, repository, parentKey string) string {
	records, err := e.records()
	if err != nil {
		return ""
	}
	var best layerRecord
	for _, record := range records {
		if record.Main && record.Kind == kind && record.Repository == repository && record.ParentKey == parentKey && record.CreatedAt.After(best.CreatedAt) {
			best = record
		}
	}
	return best.Name
}

// buildLayer boots a prepare VM from the parent (image or snapshot) with the
// layer's network allowlist, runs dependency code as agent, records the inventory,
// flushes, stops, and captures the disk as the layer snapshot.
func (e *environments) buildLayer(ctx context.Context, record layerRecord, value recipe, parent string, inputs map[string][]byte) (inventory map[string]string, runErr error) {
	if parent == "" && e.config.Image != DefaultImage {
		return nil, fmt.Errorf("%w: unapproved layer base image", ErrUnavailable)
	}
	buildCtx, cancel := context.WithTimeout(ctx, e.config.PrepareTimeout)
	defer cancel()
	machine := "smthrs-prep-" + strings.TrimPrefix(e.runtime.owner, "smithers-backend-")[:8] + "-" + newExecID()[1:13]
	if err := e.runtime.reserveAuxVM(ctx, machine); err != nil {
		return nil, err
	}
	defer func() { runErr = errors.Join(runErr, e.runtime.finishAuxVM(machine)) }()
	args := []string{"-n", machine, "-c", strconv.Itoa(e.config.PrepareCPUs), "-m", strconv.Itoa(e.config.PrepareMemoryMiB) + "M", "-q",
		"--no-net", "--net-rule", "allow@dns",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + e.runtime.owner,
		"--label", holderLabel + "=" + e.runtime.holder, "--label", layerLabel + "=prepare"}
	for _, domain := range value.allowlist() {
		args = append(args, "--net-rule", "allow@"+domain)
	}
	if parent == "" {
		pull := "if-missing"
		if e.runtime.config.Bundle != nil {
			pull = "never"
		}
		args = append([]string{"create", e.config.Image, "--pull", pull, "--root-disk", strconv.Itoa(e.config.PrepareDiskMiB) + "M"}, args...)
	} else {
		args = append([]string{"run", "--from-snapshot", parent, "-d"}, args...)
	}
	if _, err := e.runtime.cli.run(buildCtx, nil, args...); err != nil {
		return nil, fmt.Errorf("%w: boot prepare VM: %v", ErrUnavailable, err)
	}

	if err := e.runtime.installGuest(buildCtx, machine); err != nil {
		return nil, err
	}
	if _, err := e.runtime.guest(buildCtx, machine, nil, "setup", guestUser, strconv.Itoa(guestUID), cacheRoot); err != nil {
		return nil, err
	}
	if len(inputs) > 0 {
		// No branch bytes reach a raw root shell. Plant regular files only
		// after the pinned helper has dropped to the agent identity.
		plant, err := dependencyInputScript(inputs)
		if err != nil {
			return nil, err
		}
		// Keep each envelope below the helper's 1 MiB transport bound even
		// for a multi-megabyte lockfile. Each line is a complete absolute write.
		batch := "set -e\n"
		flush := func() error {
			_, err := e.runRecipe(buildCtx, machine, batch, guestUser, guestHome)
			batch = "set -e\n"
			return err
		}
		for _, line := range strings.Split(plant, "\n") {
			if len(batch)+len(line) > 512<<10 {
				if err := flush(); err != nil {
					return nil, fmt.Errorf("plant layer inputs: %w", err)
				}
			}
			batch += line + "\n"
		}
		if err := flush(); err != nil {
			return nil, fmt.Errorf("plant layer inputs: %w", err)
		}
	}
	if toolchain, ok := value.(toolchainLayer); ok {
		// Only shipped apt argv has root authority. Browser installers and
		// repository-selected JavaScript execute below as agent.
		if _, err := e.runToolchainRecipe(buildCtx, machine, toolchain); err != nil {
			return nil, err
		}
		// apt may restore privilege helpers; strip them before agent installers.
		if _, err := e.runtime.guest(buildCtx, machine, nil, "sanitize-system"); err != nil {
			return nil, err
		}
	}
	output, err := e.runRecipe(buildCtx, machine, value.script(), guestUser, guestHome)
	if err != nil {
		return nil, fmt.Errorf("build %s layer %s: %w", record.Kind, record.Key[:12], err)
	}
	inventory = parseInventory(output)
	marker, _ := json.Marshal(map[string]string{"kind": record.Kind, "key": record.Key, "name": record.Name})
	markerScript := "set -e; mkdir -p " + layerMarkerDir + "; printf '%s' " + shellQuote(string(marker)) + " > " + shellQuote(layerMarkerDir+"/"+record.Kind+".json")
	if _, err := e.runRecipe(buildCtx, machine, markerScript, guestUser, guestHome); err != nil {
		return nil, err
	}
	if _, err := e.runRoot(buildCtx, machine, rootSyncScript); err != nil {
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

// runRoot runs only a binary-pinned script through the root-recipe helper and returns
// its stdout, failing with the tail of its output when it exits nonzero.
func (e *environments) runRoot(ctx context.Context, machine, script string) (string, error) {
	if script != rootSyncScript {
		return "", fmt.Errorf("unapproved root recipe digest")
	}
	body, _ := json.Marshal(map[string]any{"script": script})
	return e.runPreparation(ctx, machine, body, "root-recipe", scriptDigest(script))
}

func preparationEnvironment(user, home string) map[string]string {
	env := map[string]string{"HOME": home, "TMPDIR": "/var/tmp", "DEBIAN_FRONTEND": "noninteractive"}
	if user == "root" {
		// The helper merges env.json, whose PATH and PYTHONPATH deliberately
		// include agent-writable dependency caches. Privileged preparation
		// must resolve only shipped system executables and Python modules.
		env["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
		env["PYTHONPATH"] = ""
	}
	return env
}

func (e *environments) runRecipe(ctx context.Context, machine, script, user, home string) (string, error) {
	// execRequest contains only strings, []string and map[string]string, with
	// no custom marshalers or cyclic values, so JSON encoding cannot fail.
	id := newExecID()
	request, _ := json.Marshal(execRequest{ID: id, Argv: []string{"/bin/bash", "-c", script}, Cwd: "/", User: user,
		Env: preparationEnvironment(user, home)})
	return e.runPreparation(ctx, machine, request, "exec", id)
}

func (e *environments) runPreparation(ctx context.Context, machine string, request []byte, subcommand ...string) (string, error) {
	cmd := e.runtime.cli.command(guestArgs(machine, nil, false, subcommand...)...)
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
	snapshot := stderr.completedStderr()
	out, _ := stdout.text()
	errText := snapshot.text
	if !snapshot.hasExit {
		return "", fmt.Errorf("%w: prepare command lost (%v): %s", ErrUnavailable, waitErr, tail(errText))
	}
	if snapshot.exitCode != 0 {
		if strings.Contains(out+errText, "invalid_download_destination") {
			return "", &RecipeError{Code: "invalid_download_destination", Class: "user", Message: "Toolchain download destination escapes or aliases its root", Fix: "Use a regular file under " + toolchainRoot}
		}
		return "", fmt.Errorf("exited %d: %s", snapshot.exitCode, tail(out+errText))
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

// Flush only: branch-derived recipe markers are written and read as agent.
const rootSyncScript = `sync`

// verify boots a fresh offline VM from the layer and checks its marker: the
// quarry's rule that a captured base must still hold what was prepared.
func (e *environments) verify(ctx context.Context, record layerRecord) (runErr error) {
	names := []string{record.Name}
	if record.ParentKey != "" {
		names = append(names, e.layerName(layerToolchain, record.ParentKey))
	}
	defer e.pin(names...)()
	if err := e.admit(ctx); err != nil {
		return &layerAdmissionError{err}
	}
	machine := "smthrs-vfy-" + strings.TrimPrefix(e.runtime.owner, "smithers-backend-")[:8] + "-" + newExecID()[1:13]
	if err := e.runtime.reserveAuxVM(ctx, machine); err != nil {
		return &layerAdmissionError{err}
	}
	defer func() {
		if err := e.runtime.finishAuxVM(machine); err != nil {
			runErr = errors.Join(runErr, &layerAdmissionError{err})
		}
	}()
	args := []string{"run", "--from-snapshot", record.Name, "-d", "-n", machine, "-c", strconv.Itoa(e.runtime.config.CPUs), "-m", strconv.Itoa(e.runtime.config.MemoryMiB) + "M", "-q", "--no-net",
		"--label", providerLabel + "=" + providerName, "--label", ownerLabel + "=" + e.runtime.owner, "--label", layerLabel + "=verify"}
	verifyCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if _, err := e.runtime.cli.run(verifyCtx, nil, args...); err != nil {
		return &layerAdmissionError{fmt.Errorf("%w: boot layer %s for verification: %v", ErrUnavailable, record.Name, err)}
	}
	if err := e.runtime.installGuest(verifyCtx, machine); err != nil {
		return err
	}
	output, err := e.runRecipe(verifyCtx, machine, "cat "+shellQuote(layerMarkerDir+"/"+record.Kind+".json"), guestUser, guestHome)
	if err != nil {
		// A CLI exit alone cannot distinguish guest cat failure from transport
		// failure. Only a successful guest probe proves marker absence.
		probe, probeErr := e.runRecipe(verifyCtx, machine, "if [ -e "+shellQuote(layerMarkerDir+"/"+record.Kind+".json")+" ]; then printf present; else printf missing; fi", guestUser, guestHome)
		if probeErr == nil && string(probe) == "missing" {
			return fmt.Errorf("layer %s does not hold its preparation marker", record.Name)
		}
		return &layerAdmissionError{fmt.Errorf("read layer %s marker: %w", record.Name, err)}
	}
	var marker map[string]string
	if json.Unmarshal([]byte(output), &marker) != nil || marker["key"] != record.Key {
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

func dependencyInputScript(files map[string][]byte) (string, error) {
	var script strings.Builder
	fmt.Fprintf(&script, "set -e; rm -rf %s/prepare; mkdir -p %s/prepare/src\n", cacheRoot, cacheRoot)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if name == "." || path.IsAbs(name) || path.Clean(name) != name || hasParentComponent(name) || strings.ContainsAny(name, "\\\x00\n\r") {
			return "", &RecipeError{Code: "invalid_dependency_input", Class: "user", Message: "Invalid dependency input: " + name}
		}
		destination := cacheRoot + "/prepare/src/" + name
		fmt.Fprintf(&script, "mkdir -p %s; : > %s\n", shellQuote(path.Dir(destination)), shellQuote(destination))
		body := files[name]
		for len(body) > 0 {
			size := min(len(body), 48<<10)
			fmt.Fprintf(&script, "printf '%%s' %s | base64 -d >> %s\n", shellQuote(base64.StdEncoding.EncodeToString(body[:size])), shellQuote(destination))
			body = body[size:]
		}
	}
	return script.String(), nil
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

// targetIndexPath is the authoritative declaration index when present.
const targetIndexPath = ".smithers/target-index.json"

// indexTarget is one row of the committed target index, as far as layers read
// it. Destinations is nil when the declaration states none, which a
// download-performing node is refused for; a declared empty list is kept.
type indexTarget struct {
	Label   string `json:"label"`
	Package string `json:"package"`
	Rule    string `json:"rule"`
	Inputs  []struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
	} `json:"inputs"`
	Destinations *[]string       `json:"destinations"`
	Toolchain    *indexToolchain `json:"toolchain"`
}

// indexToolchain is an Environment.Toolchain row's pinned releases.
type indexToolchain struct {
	Downloads map[string]download `json:"downloads"`
	Rust      *struct {
		Channel    string   `json:"channel"`
		Components []string `json:"components"`
		Targets    []string `json:"targets"`
	} `json:"rust"`
	Postgres string `json:"postgres"`
}

// readTargetIndex returns nil only when the committed index is absent.
// A present index is authoritative, including an invalid or empty index.
func readTargetIndex(read func(string) ([]byte, bool, error)) ([]indexTarget, error) {
	contents, ok, err := read(targetIndexPath)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	targets := []indexTarget{}
	if err := json.Unmarshal(contents, &targets); err != nil {
		return nil, fmt.Errorf("decode %s: %w", targetIndexPath, err)
	}
	if targets == nil {
		return nil, fmt.Errorf("decode %s: expected a list", targetIndexPath)
	}
	return targets, nil
}

// download is one pinned artifact and its reviewed SHA-256 (linux/arm64).
type download struct {
	Destination string `json:"destination,omitempty"`
	Version     string `json:"version"`
	URL         string `json:"url"`
	SHA256      string `json:"sha256"`
}

// requiredTools are the tools the toolchain script installs.
var requiredTools = []string{"node", "pnpm", "bun", "go", "jj", "rg", "fd", "jq"}

// pgdgKeyFingerprint pins the PostgreSQL apt repository signing key.
const pgdgKeyFingerprint = "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"

type toolchainLayer struct {
	DetectorVersion string              `json:"detectorVersion,omitempty"`
	Packages        []string            `json:"packages,omitempty"`
	Image           string              `json:"image"`
	Label           string              `json:"label"`
	Downloads       map[string]download `json:"downloads"`
	Rust            string              `json:"rust,omitempty"`
	RustParts       []string            `json:"rustComponents,omitempty"`
	RustTargs       []string            `json:"rustTargets,omitempty"`
	Postgres        string              `json:"postgres,omitempty"`
	Destinations    []string            `json:"destinations"`
}

var (
	versionPattern  = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]*$`)
	sha256Pattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	postgresPattern = regexp.MustCompile(`^[0-9]{1,2}$`)
)

// toolchainRecipe normalizes detected evidence or the authoritative index row
// into one pinned-artifact validator and layer identity.
func toolchainRecipe(image string, targets []indexTarget, evidence ...Recipe) (toolchainLayer, error) {
	var rows []indexTarget
	for _, target := range targets {
		if target.Rule == "Environment.Toolchain" {
			rows = append(rows, target)
		}
	}
	var detectorVersion string
	required := append([]string(nil), requiredTools...)
	if targets == nil && len(evidence) > 0 {
		detected := evidence[0]
		detectorVersion = detected.DetectorVersion
		pins := map[string]download{}
		hosts := map[string]bool{}
		for tool, requested := range detected.Tools {
			pinned, err := resolveDetectedTool(tool, requested)
			if err != nil {
				return toolchainLayer{}, err
			}
			pins[tool] = pinned
			host, err := httpsHost(pinned.URL)
			if err != nil {
				return toolchainLayer{}, err
			}
			hosts[host] = true
			if host == "go.dev" {
				hosts["dl.google.com"] = true
			}
			if host == "github.com" {
				hosts["release-assets.githubusercontent.com"] = true
				hosts["objects.githubusercontent.com"] = true
			}
		}
		destinations := sortedKeys(hosts)
		rows = []indexTarget{{Label: "detected", Destinations: &destinations, Toolchain: &indexToolchain{Downloads: pins}}}
		required = sortedDownloadKeys(pins)
	}

	if len(rows) != 1 {
		return toolchainLayer{}, fmt.Errorf("%s declares %d Environment.Toolchain targets; a prepared environment needs exactly one", targetIndexPath, len(rows))
	}
	row := rows[0]
	if row.Toolchain == nil {
		return toolchainLayer{}, fmt.Errorf("%s carries no toolchain pins", row.Label)
	}
	if row.Destinations == nil {
		return toolchainLayer{}, fmt.Errorf("%s declares no network destinations", row.Label)
	}
	layer := toolchainLayer{Image: image, DetectorVersion: detectorVersion, Label: row.Label, Downloads: map[string]download{}, Postgres: row.Toolchain.Postgres}
	destinations, err := destinationSet(row.Label, *row.Destinations)
	if err != nil {
		return toolchainLayer{}, err
	}
	if rust := row.Toolchain.Rust; rust != nil {
		if strings.TrimSpace(rust.Channel) == "" {
			return toolchainLayer{}, fmt.Errorf("%s declares a Rust toolchain with no channel", row.Label)
		}
		layer.Rust = rust.Channel
		layer.RustParts = sortedCopy(rust.Components)
		layer.RustTargs = sortedCopy(rust.Targets)
		required = append(required, "rustup")
	}
	// The guest helper accepts one or two digits; refuse anything else here.
	if layer.Postgres != "" && !postgresPattern.MatchString(layer.Postgres) {
		return toolchainLayer{}, recipeRefusal(targetIndexPath, fmt.Sprintf("%s declares PostgreSQL %q, not a major version", row.Label, layer.Postgres))
	}
	for _, pinned := range row.Toolchain.Downloads {
		if pinned.Destination != "" && (filepath.IsAbs(pinned.Destination) || filepath.Clean(pinned.Destination) != pinned.Destination || pinned.Destination == "." || strings.Contains(pinned.Destination, "\\") || strings.ContainsRune(pinned.Destination, 0) || hasParentComponent(pinned.Destination)) {
			return toolchainLayer{}, &RecipeError{Code: "invalid_download_destination", Class: "user", Message: "Invalid toolchain download destination: " + pinned.Destination, Fix: "Use a clean relative path under " + toolchainRoot}
		}
	}
	for _, tool := range required {
		pinned, ok := row.Toolchain.Downloads[tool]
		if !ok {
			return toolchainLayer{}, fmt.Errorf("%s pins no %s download", row.Label, tool)
		}
		if !versionPattern.MatchString(pinned.Version) || !sha256Pattern.MatchString(pinned.SHA256) {
			return toolchainLayer{}, fmt.Errorf("%s pins %s without an exact version and SHA-256", row.Label, tool)
		}
		host, err := httpsHost(pinned.URL)
		if err != nil {
			return toolchainLayer{}, fmt.Errorf("%s pins %s at %q: %w", row.Label, tool, pinned.URL, err)
		}
		if !destinations[host] {
			return toolchainLayer{}, fmt.Errorf("%s fetches %s from %s, which is not among its destinations", row.Label, tool, host)
		}
		layer.Downloads[tool] = pinned
	}
	// The script reaches these hosts itself: rustup downloads the declared
	// channel from its dist server, and PostgreSQL comes from its signed apt
	// repository after its key.
	var procedure []string
	if layer.Rust != "" {
		procedure = append(procedure, "static.rust-lang.org")
	}
	if layer.Postgres != "" {
		procedure = append(procedure, "www.postgresql.org", "apt.postgresql.org")
	}
	for _, host := range procedure {
		if !destinations[host] {
			return toolchainLayer{}, fmt.Errorf("%s installs from %s, which is not among its destinations", row.Label, host)
		}
	}
	layer.Destinations = sortedKeys(destinations)
	return layer, nil
}

func hasParentComponent(destination string) bool {
	for _, part := range strings.Split(destination, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// destinationSet validates a node's declared hosts.
func destinationSet(label string, hosts []string) (map[string]bool, error) {
	set := map[string]bool{}
	for _, host := range hosts {
		if !dnsName.MatchString(host) {
			return nil, fmt.Errorf("%s declares an invalid network destination %q", label, host)
		}
		set[host] = true
	}
	return set, nil
}

var dnsName = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)

// httpsHost returns the host of an https URL.
func httpsHost(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return "", errors.New("not an https URL")
	}
	return strings.ToLower(parsed.Hostname()), nil
}

func sortedCopy(items []string) []string {
	if len(items) == 0 {
		return nil
	}
	out := append([]string(nil), items...)
	sort.Strings(out)
	return out
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func (t toolchainLayer) kind() string   { return layerToolchain }
func (t toolchainLayer) link() []string { return nil }

// allowlist combines declared artifacts with shipped system-package destinations. Domain rules match
// the DNS name a connection resolved through, so the declaration lists CDN
// CNAME targets beside the names that alias them.
func (t toolchainLayer) allowlist() []string { return withAptDestinations(t.Destinations) }

// toolchainSystemScript is binary-pinned. Variable inputs are validated data,
// passed as positional arguments, never interpolated into privileged code.
const toolchainSystemScript = `set -euo pipefail
` + playwrightSystemPackages + `
postgres="$1"; environment="$2"; shift 2
if [ "$#" -gt 0 ]; then
 apt-get update -qq; apt-get install -y -qq --no-install-recommends "$@" >/dev/null
 rm -rf /var/lib/apt/lists/*
fi
if [ -n "$postgres" ]; then
 pgdir=$(mktemp -d /root/smithers-pgdg.XXXXXXXX)
 trap 'rm -rf "$pgdir"' EXIT
 curl -fsSL --retry 4 -o "$pgdir/key.asc" https://www.postgresql.org/media/keys/ACCC4CF8.asc
 gpg --batch --quiet --show-keys --with-colons "$pgdir/key.asc" | grep -q '^fpr:::::::::` + pgdgKeyFingerprint + `:$'
 gpg --batch --quiet --dearmor < "$pgdir/key.asc" > /usr/share/keyrings/pgdg.gpg
 echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt $(. /etc/os-release; echo $VERSION_CODENAME)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
 apt-get update -qq; apt-get install -y -qq --no-install-recommends "postgresql-$postgres" >/dev/null
 rm -rf /var/lib/apt/lists/*
fi
mkdir -p /opt/smithers/toolchain /opt/smithers/rust
chown -R 19999:19999 /opt/smithers/toolchain /opt/smithers/rust
printf '%s' "$environment" > /opt/smithers/env.json
chmod 0644 /opt/smithers/env.json
`

func (t toolchainLayer) systemScript() string { return toolchainSystemScript }

func (e *environments) runToolchainRecipe(ctx context.Context, machine string, t toolchainLayer) (string, error) {
	body, err := json.Marshal(map[string]any{"script": toolchainSystemScript, "toolchain": map[string]any{"packages": t.Packages, "postgres": t.Postgres, "environment": t.environment()}})
	if err != nil {
		return "", err
	}
	return e.runPreparation(ctx, machine, body, "root-recipe", scriptDigest(toolchainSystemScript))
}

func (t toolchainLayer) environment() map[string]string {
	pathEntries := []string{toolchainRoot + "/bin", toolchainRoot + "/node/bin", toolchainRoot + "/go/bin", toolchainRoot + "/rust/bin", toolchainRoot + "/python/bin", cacheRoot + "/python-site/bin", "/opt/smithers/rust/cargo/bin"}
	if t.Postgres != "" {
		pathEntries = append(pathEntries, "/usr/lib/postgresql/"+t.Postgres+"/bin")
	}

	pathEntries = append(pathEntries, "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin")
	return map[string]string{
		"PATH": strings.Join(pathEntries, ":"), "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOFLAGS": "-mod=readonly",
		"GOMODCACHE": cacheRoot + "/gomod", "GOCACHE": cacheRoot + "/gocache", "RUSTUP_HOME": "/opt/smithers/rust/rustup",
		"CARGO_HOME": cacheRoot + "/cargo", "pnpm_config_store_dir": cacheRoot + "/pnpm-store", "pnpm_config_cache_dir": cacheRoot + "/pnpm-cache", "PLAYWRIGHT_BROWSERS_PATH": cacheRoot + "/ms-playwright",
		"npm_config_store_dir": cacheRoot + "/pnpm-store", "npm_config_cache": cacheRoot + "/npm", "YARN_CACHE_FOLDER": cacheRoot + "/yarn", "BUN_INSTALL_CACHE_DIR": cacheRoot + "/bun", "UV_CACHE_DIR": cacheRoot + "/uv", "UV_PYTHON_DOWNLOADS": "never", "PIP_CACHE_DIR": cacheRoot + "/pip", "PIP_FIND_LINKS": cacheRoot + "/wheels", "PIP_TARGET": cacheRoot + "/python-site", "PYTHONPATH": cacheRoot + "/python-site",
		"COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "CI": "1", "LANG": "C.UTF-8", "DPRINT_CACHE_DIR": cacheRoot + "/dprint",
	}
}

func (t toolchainLayer) script() string {
	var s strings.Builder
	fmt.Fprintf(&s, `set -euo pipefail
T=%[1]s; mkdir -p "$T/bin" /var/tmp/dl %[2]s
fetch() {
 /usr/bin/python3 -I - "$T" "$3" "$1" "$2" <<'SMITHERS_FETCH'
import hashlib, os, stat, subprocess, sys
root, destination, url, checksum = sys.argv[1:]
try:
 if not destination.startswith(root + "/"):
  raise ValueError("outside root")
 relative = destination[len(root)+1:]
 parts = relative.split("/")
 if any(p in ("", ".", "..") or "\\" in p or "\x00" in p for p in parts):
  raise ValueError("invalid path")
 # Resolve every ancestor and the leaf through held no-follow descriptors.
 # No path check followed by a pathname-based curl write (TOCTOU).
 fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
 for part in root.strip("/").split("/") + parts[:-1]:
  try: os.mkdir(part, 0o755, dir_fd=fd)
  except FileExistsError: pass
  child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
  os.close(fd); fd = child
 out = os.open(parts[-1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
 info = os.fstat(out)
 if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
  os.close(out); raise ValueError("not a private regular file")
except (OSError, ValueError) as error:
 sys.exit("invalid_download_destination: " + str(error))
os.close(fd)
with os.fdopen(out, "w+b") as handle:
 handle.truncate(0)
 subprocess.run(["curl", "-fsSL", "--retry", "4", "--retry-all-errors", url], stdout=handle, check=True)
 handle.flush(); handle.seek(0)
 digest = hashlib.sha256()
 for chunk in iter(lambda: handle.read(1048576), b""): digest.update(chunk)
 if digest.hexdigest() != checksum:
  sys.exit("toolchain checksum mismatch")
SMITHERS_FETCH
}

`, toolchainRoot, cacheRoot)
	d := t.Downloads
	if _, ok := d["node"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/node.tar.xz; mkdir -p $T/node; tar -xJf /var/tmp/dl/node.tar.xz -C $T/node --strip-components=1\n", shellQuote(d["node"].URL), d["node"].SHA256)
	}
	if _, ok := d["pnpm"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/pnpm.tgz; mkdir -p $T/pnpm; tar -xzf /var/tmp/dl/pnpm.tgz -C $T/pnpm --strip-components=1; chmod 0755 $T/pnpm/bin/*.cjs; ln -sf $T/pnpm/bin/pnpm.cjs $T/bin/pnpm; ln -sf $T/pnpm/bin/pnpx.cjs $T/bin/pnpx\n", shellQuote(d["pnpm"].URL), d["pnpm"].SHA256)
	}
	if _, ok := d["bun"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/bun.zip; python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' /var/tmp/dl/bun.zip /var/tmp/dl/bun; install -m 0755 /var/tmp/dl/bun/*/bun $T/bin/bun\n", shellQuote(d["bun"].URL), d["bun"].SHA256)
	}
	if _, ok := d["go"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/go.tgz; tar -xzf /var/tmp/dl/go.tgz -C $T\n", shellQuote(d["go"].URL), d["go"].SHA256)
	}
	if _, ok := d["jj"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/jj.tgz; tar -xzf /var/tmp/dl/jj.tgz -C $T/bin ./jj\n", shellQuote(d["jj"].URL), d["jj"].SHA256)
	}
	if _, ok := d["rg"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/rg.tgz; tar -xzf /var/tmp/dl/rg.tgz -C $T/bin --strip-components=1 --wildcards '*/rg'\n", shellQuote(d["rg"].URL), d["rg"].SHA256)
	}
	if _, ok := d["fd"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/fd.tgz; tar -xzf /var/tmp/dl/fd.tgz -C $T/bin --strip-components=1 --wildcards '*/fd'\n", shellQuote(d["fd"].URL), d["fd"].SHA256)
	}
	if _, ok := d["jq"]; ok {
		fmt.Fprintf(&s, "fetch %s %s $T/bin/jq; chmod 0755 $T/bin/jq\n", shellQuote(d["jq"].URL), d["jq"].SHA256)
	}
	for _, manager := range []string{"npm", "yarn"} {
		if pinned, ok := d[manager]; ok {
			fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/%s.tgz; mkdir -p $T/%s; tar -xzf /var/tmp/dl/%s.tgz -C $T/%s --strip-components=1\n", shellQuote(pinned.URL), pinned.SHA256, manager, manager, manager, manager)
			if manager == "npm" {
				s.WriteString("ln -sf $T/npm/bin/npm-cli.js $T/bin/npm; ln -sf $T/npm/bin/npx-cli.js $T/bin/npx\n")
			} else {
				s.WriteString("ln -sf $T/yarn/bin/yarn.js $T/bin/yarn\n")
			}
		}
	}
	if pinned, ok := d["rust"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/rust.tar.xz; mkdir /var/tmp/dl/rust; tar -xJf /var/tmp/dl/rust.tar.xz -C /var/tmp/dl/rust --strip-components=1; /var/tmp/dl/rust/install.sh --disable-ldconfig --prefix=$T/rust\n", shellQuote(pinned.URL), pinned.SHA256)
	}
	if pinned, ok := d["python"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/python.tar.gz; tar -xzf /var/tmp/dl/python.tar.gz -C $T; ln -sf $T/python/bin/python3 $T/bin/python\n", shellQuote(pinned.URL), pinned.SHA256)
	}
	if pinned, ok := d["uv"]; ok {
		fmt.Fprintf(&s, "fetch %s %s /var/tmp/dl/uv.tar.gz; tar -xzf /var/tmp/dl/uv.tar.gz -C $T/bin --strip-components=1 --wildcards '*/uv'\n", shellQuote(pinned.URL), pinned.SHA256)
	}

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
	s.WriteString("rm -rf /var/tmp/dl\n")
	// The toolchain's cargo binaries are shared read-only; each build's
	// registry cache lives in the writable dependency cache.
	fmt.Fprintf(&s, "mkdir -p %[1]s/gomod %[1]s/gocache %[1]s/cargo %[1]s/pnpm-store %[1]s/pnpm-cache %[1]s/ms-playwright %[1]s/home %[1]s/dprint %[1]s/npm %[1]s/yarn %[1]s/bun %[1]s/uv %[1]s/pip %[1]s/wheels %[1]s/python-site\n", cacheRoot)
	s.WriteString("export PATH=" + shellQuote(t.environment()["PATH"]) + "\n")
	s.WriteString(`echo "inventory toolchain-uid $(id -u)"
`)
	commands := map[string]string{"node": "node --version", "pnpm": "pnpm --version", "npm": "npm --version", "yarn": "yarn --version", "bun": "bun --version", "go": "go version", "jj": "jj --version", "rg": "rg --version | head -1", "fd": "fd --version", "jq": "jq --version", "rust": "rustc --version", "python": "python3 --version", "uv": "uv --version"}
	for _, tool := range sortedDownloadKeys(d) {
		if command, ok := commands[tool]; ok {
			fmt.Fprintf(&s, "echo \"inventory %s $(%s)\"\n", tool, command)
		}
	}
	if t.Postgres != "" {
		s.WriteString(`echo "inventory postgres $(postgres --version)"
`)
	}
	if t.Rust != "" {
		s.WriteString(`echo "inventory rustc $(RUSTUP_HOME=/opt/smithers/rust/rustup /opt/smithers/rust/cargo/bin/rustc --version)"
echo "inventory cargo $(RUSTUP_HOME=/opt/smithers/rust/rustup /opt/smithers/rust/cargo/bin/cargo --version)"
`)
	}
	script := strings.ReplaceAll(s.String(), "/var/tmp/dl", toolchainRoot+"/.downloads")
	defaults := map[string]string{"node": "/var/tmp/dl/node.tar.xz", "pnpm": "/var/tmp/dl/pnpm.tgz", "bun": "/var/tmp/dl/bun.zip", "go": "/var/tmp/dl/go.tgz", "jj": "/var/tmp/dl/jj.tgz", "rg": "/var/tmp/dl/rg.tgz", "fd": "/var/tmp/dl/fd.tgz", "jq": "$T/bin/jq", "npm": "/var/tmp/dl/npm.tgz", "yarn": "/var/tmp/dl/yarn.tgz", "rust": "/var/tmp/dl/rust.tar.xz", "python": "/var/tmp/dl/python.tar.gz", "uv": "/var/tmp/dl/uv.tar.gz", "rustup": "/var/tmp/dl/rustup-init"}
	var destinations strings.Builder
	for _, tool := range sortedDownloadKeys(d) {
		defaultPath, ok := defaults[tool]
		if !ok {
			continue
		}
		defaultPath = strings.ReplaceAll(defaultPath, "/var/tmp/dl", toolchainRoot+"/.downloads")
		destination := strings.ReplaceAll(defaultPath, "$T", toolchainRoot)
		if d[tool].Destination != "" {
			destination = toolchainRoot + "/" + d[tool].Destination
		}
		variable := "SMITHERS_DOWNLOAD_" + tool
		// Substitute only shipped placeholders, before inserting any declared
		// path. A declaration cannot rewrite another artifact's destination.
		script = strings.ReplaceAll(script, defaultPath, "\"$"+variable+"\"")
		fmt.Fprintf(&destinations, "%s=%s\n", variable, shellQuote(destination))
	}
	return destinations.String() + script
}

// ---- L2: dependencies ----

type dependencyNode struct {
	Label        string            `json:"label"`
	Rule         string            `json:"rule"`
	Files        map[string]string `json:"files"`
	Destinations []string          `json:"destinations,omitempty"`
}

type dependencyLayer struct {
	DetectorVersion     string            `json:"detectorVersion,omitempty"`
	Installs            []DetectedInstall `json:"installs,omitempty"`
	UVBuildRequirements []string          `json:"uvBuildRequirements,omitempty"`
	Toolchain           string            `json:"toolchain"`
	Nodes               []dependencyNode  `json:"nodes"`
	Tools               []toolNode        `json:"tools,omitempty"`
	Playwright          []string          `json:"playwright,omitempty"`
	// Dprint is the package that runs dprint and the plugins every Dprint
	// node's config names; the layer fills dprint's cache with them.
	Dprint        string   `json:"dprint,omitempty"`
	DprintPlugins []string `json:"dprintPlugins,omitempty"`
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

// dprintPlugins lists the distinct plugin URLs the dprint configs name,
// keeping a checksummed spelling when one exists.
func dprintPlugins(node *dependencyNode, inputs map[string][]byte) []string {
	byURL := map[string]string{}
	for file := range node.Files {
		var config struct {
			Plugins []string `json:"plugins"`
		}
		if json.Unmarshal(inputs[file], &config) != nil {
			continue
		}
		for _, plugin := range config.Plugins {
			if !strings.HasPrefix(plugin, "https://") {
				continue
			}
			url := strings.SplitN(plugin, "@", 2)[0]
			if existing, ok := byURL[url]; !ok || !strings.Contains(existing, "@") {
				byURL[url] = plugin
			}
		}
	}
	plugins := make([]string, 0, len(byURL))
	for _, plugin := range byURL {
		plugins = append(plugins, plugin)
	}
	sort.Strings(plugins)
	return plugins
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

// declaredDestinations returns a download-performing node's declared hosts,
// refusing a node that declares none: no node inherits hosts it did not state.
func declaredDestinations(target indexTarget) ([]string, error) {
	if target.Destinations == nil {
		return nil, fmt.Errorf("%s declares no network destinations; add destinations to its declaration", target.Label)
	}
	set, err := destinationSet(target.Label, *target.Destinations)
	if err != nil {
		return nil, err
	}
	return sortedKeys(set), nil
}

// dependencyRecipe assembles one content-addressed layer from detected installs
// or the authoritative committed target index.
func dependencyRecipe(toolchainKey string, targets []indexTarget, read func(string) ([]byte, bool, error), evidence ...Recipe) (dependencyLayer, map[string][]byte, error) {
	if targets == nil && len(evidence) > 0 {
		detected := evidence[0]
		layer := dependencyLayer{Toolchain: toolchainKey, DetectorVersion: detected.DetectorVersion, Installs: detected.Installs}
		inputs := map[string][]byte{}
		for i, install := range detected.Installs {
			hosts, err := destinationSet("detected dependency install", install.Destinations)
			if err != nil {
				return dependencyLayer{}, nil, err
			}
			node := dependencyNode{Label: fmt.Sprintf("detected:%d", i), Rule: "Detected.Install", Files: map[string]string{}, Destinations: sortedKeys(hosts)}
			store := func(name string, data []byte) error {
				if name == "" || path.IsAbs(name) || path.Clean(name) != name || strings.Contains(name, "..") || strings.ContainsAny(name, "\\\x00") {
					return fmt.Errorf("invalid detected dependency input %q", name)
				}
				node.Files[name] = digest(string(data))
				inputs[name] = data
				return nil
			}
			add := func(name string) error {
				if name == "" || path.IsAbs(name) || path.Clean(name) != name || strings.Contains(name, "..") || strings.ContainsAny(name, "\\\x00") {
					return fmt.Errorf("invalid detected dependency input %q", name)
				}
				data, ok, err := read(name)
				if err != nil {
					return err
				}
				if !ok {
					node.Files[name] = "absent"
					return nil
				}
				if strings.ContainsAny(name, "*?[") {
					var listing map[string]string
					if err := json.Unmarshal(data, &listing); err != nil {
						return fmt.Errorf("decode dependency input listing %s: %w", name, err)
					}
					for filename, contents := range listing {
						matched, err := path.Match(name, filename)
						if err != nil || !matched {
							return fmt.Errorf("dependency input %q does not match %q", filename, name)
						}
						if err := store(filename, []byte(contents)); err != nil {
							return err
						}
					}
					return nil
				}
				return store(name, data)
			}
			for _, name := range install.Files {
				if name == "requirements*.txt" {
					data, ok, err := read(name)
					if err != nil {
						return dependencyLayer{}, nil, err
					}
					if !ok {
						continue
					}
					var requirements map[string]string
					if err := json.Unmarshal(data, &requirements); err != nil {
						return dependencyLayer{}, nil, fmt.Errorf("decode requirements file listing: %w", err)
					}
					for name, data := range requirements {
						if path.Base(name) != name || !strings.HasPrefix(name, "requirements") || !strings.HasSuffix(name, ".txt") {
							return dependencyLayer{}, nil, fmt.Errorf("invalid requirements filename %q", name)
						}
						node.Files[name] = digest(data)
						inputs[name] = []byte(data)
					}
				} else if err := add(name); err != nil {
					return dependencyLayer{}, nil, err
				}
			}
			if len(install.Command) > 0 {
				switch install.Command[0] {
				case "uv":
					var manifest struct {
						BuildSystem struct {
							Requires []string `toml:"requires"`
						} `toml:"build-system"`
					}
					if err := toml.Unmarshal(inputs["pyproject.toml"], &manifest); err != nil {
						return dependencyLayer{}, nil, fmt.Errorf("decode pyproject.toml: %w", err)
					}
					layer.UVBuildRequirements = sortedCopy(manifest.BuildSystem.Requires)
				case "go":
					if err := add("go.sum"); err != nil {
						return dependencyLayer{}, nil, err
					}
				case "cargo":
					if err := add("Cargo.lock"); err != nil {
						return dependencyLayer{}, nil, err
					}
					var manifest struct {
						Workspace struct {
							Members []string `toml:"members"`
						} `toml:"workspace"`
						Dependencies      map[string]any `toml:"dependencies"`
						DevDependencies   map[string]any `toml:"dev-dependencies"`
						BuildDependencies map[string]any `toml:"build-dependencies"`
					}
					if err := toml.Unmarshal(inputs["Cargo.toml"], &manifest); err != nil {
						return dependencyLayer{}, nil, fmt.Errorf("decode Cargo.toml: %w", err)
					}
					for _, member := range manifest.Workspace.Members {
						if err := add(member + "/Cargo.toml"); err != nil {
							return dependencyLayer{}, nil, err
						}
					}
					for _, dependencies := range []map[string]any{manifest.Dependencies, manifest.DevDependencies, manifest.BuildDependencies} {
						for _, dependency := range dependencies {
							row, _ := dependency.(map[string]any)
							localPath, _ := row["path"].(string)
							if localPath != "" {
								if err := add(localPath + "/Cargo.toml"); err != nil {
									return dependencyLayer{}, nil, err
								}
							}
						}
					}
				case "pnpm":
					if err := add("pnpm-workspace.yaml"); err != nil {
						return dependencyLayer{}, nil, err
					}
					for _, importer := range lockImporters(inputs["pnpm-lock.yaml"]) {
						if importer != "." {
							if err := add(importer + "/package.json"); err != nil {
								return dependencyLayer{}, nil, err
							}
						}
					}
				case "npm", "yarn", "bun":
					var manifest struct {
						Workspaces json.RawMessage `json:"workspaces"`
					}
					if err := json.Unmarshal(inputs["package.json"], &manifest); err != nil {
						return dependencyLayer{}, nil, fmt.Errorf("decode package.json: %w", err)
					}
					if len(manifest.Workspaces) > 0 {
						var members []string
						if json.Unmarshal(manifest.Workspaces, &members) != nil {
							var object struct {
								Packages []string `json:"packages"`
							}
							if err := json.Unmarshal(manifest.Workspaces, &object); err != nil {
								return dependencyLayer{}, nil, fmt.Errorf("decode package.json workspaces: %w", err)
							}
							members = object.Packages
						}
						for _, member := range members {
							if err := add(member + "/package.json"); err != nil {
								return dependencyLayer{}, nil, err
							}
						}
					}
				}
			}
			layer.Nodes = append(layer.Nodes, node)
		}
		return layer, inputs, nil
	}

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
	cargo := &dependencyNode{Label: "cargo", Rule: "Cargo.Fetch", Files: map[string]string{}}
	cargoHosts := map[string]bool{}
	cargoDeclared := false
	var cargoLabels []string
	dprint := &dependencyNode{Label: "dprint", Rule: "Dprint.Plugins", Files: map[string]string{}}
	for _, target := range targets {
		switch {
		case target.Rule == "Install" || target.Rule == "Go.ModDownload":
			destinations, err := declaredDestinations(target)
			if err != nil {
				return layer, nil, err
			}
			node := &dependencyNode{Label: target.Label, Rule: target.Rule, Files: map[string]string{}, Destinations: destinations}
			for _, input := range target.Inputs {
				if input.Path != "" && (input.Kind == "file" || input.Kind == "pnpm-workspace") {
					if err := addFile(node, input.Path); err != nil {
						return layer, nil, err
					}
				}
			}
			nodes[node.Label] = node
		case target.Rule == "NodeBinary" && declares(target, "pnpm-lock.yaml"):
			entry := ""
			for _, input := range target.Inputs {
				if input.Kind == "file" && (strings.HasSuffix(input.Path, ".mjs") || strings.HasSuffix(input.Path, ".cjs") || strings.HasSuffix(input.Path, ".js")) {
					entry = input.Path
					break
				}
			}
			if entry == "" || target.Package == "" || !strings.HasPrefix(entry, target.Package+"/") {
				continue
			}
			destinations, err := declaredDestinations(target)
			if err != nil {
				return layer, nil, err
			}
			node := &dependencyNode{Label: target.Label, Rule: target.Rule, Files: map[string]string{}, Destinations: destinations}
			for _, input := range target.Inputs {
				if input.Kind != "file" || input.Path == "" {
					continue
				}
				if err := addFile(node, input.Path); err != nil {
					return layer, nil, err
				}
			}
			nodes[node.Label] = node
			layer.Tools = append(layer.Tools, toolNode{Label: target.Label, Package: target.Package, Entry: strings.TrimPrefix(entry, target.Package+"/")})
		case target.Rule == "Dprint":
			for _, input := range target.Inputs {
				if input.Kind != "file" || path.Base(input.Path) != "dprint.json" {
					continue
				}
				if err := addFile(dprint, input.Path); err != nil {
					return layer, nil, err
				}
				if layer.Dprint == "" && target.Package != "" {
					layer.Dprint = target.Package
				}
			}
		case strings.HasPrefix(target.Rule, "Cargo.") || target.Label == "//:nativeFfi":
			contributes := false
			for _, input := range target.Inputs {
				base := path.Base(input.Path)
				if input.Kind == "file" && (base == "Cargo.toml" || base == "Cargo.lock" || base == "rust-toolchain.toml") {
					contributes = true
					if err := addFile(cargo, input.Path); err != nil {
						return layer, nil, err
					}
				}
			}
			if contributes {
				cargoLabels = append(cargoLabels, target.Label)
			}
			if target.Destinations != nil {
				set, err := destinationSet(target.Label, *target.Destinations)
				if err != nil {
					return layer, nil, err
				}
				cargoDeclared = true
				for host := range set {
					cargoHosts[host] = true
				}
			}
		}
	}
	if len(cargo.Files) > 0 {
		// One cargo fetch serves every Cargo node; the nodes that resolve
		// crates declare where from.
		if !cargoDeclared {
			return layer, nil, fmt.Errorf("%s declare no network destinations for the cargo fetch; add destinations to a Cargo declaration", strings.Join(cargoLabels, ", "))
		}
		cargo.Destinations = sortedKeys(cargoHosts)
		nodes[cargo.Label] = cargo
	}
	if len(dprint.Files) > 0 {
		layer.DprintPlugins = dprintPlugins(dprint, inputs)
		// A plugin's host is part of its declared URL.
		hosts := map[string]bool{}
		for _, plugin := range layer.DprintPlugins {
			if host, err := httpsHost(strings.SplitN(plugin, "@", 2)[0]); err == nil {
				hosts[host] = true
			}
		}
		dprint.Destinations = sortedKeys(hosts)
		nodes[dprint.Label] = dprint
	}
	// The pnpm-workspace input kind covers the workspace's member manifests;
	// the lockfile's importers name them, so the install can link offline.
	for _, node := range nodes {
		if node.Rule != "Install" {
			continue
		}
		// Workspace member manifests still come from lockfile importers until
		// the declaration index enumerates the members of pnpm-workspace inputs.
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
	if lock, ok := inputs["pnpm-lock.yaml"]; ok && layer.has("Install") {
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
	if d.DetectorVersion != "" {
		var commands []string
		var direct []string
		for _, install := range d.Installs {
			if len(install.Offline) == 0 {
				continue
			}
			command := shellArgv(install.Offline)
			direct = install.Offline
			if install.Offline[0] == "python" {
				command = "rm -rf " + shellQuote(cacheRoot+"/python-site") + "; mkdir -p " + shellQuote(cacheRoot+"/python-site") + "; " + command
				direct = nil
			}
			commands = append(commands, command)
		}
		if len(commands) == 0 {
			return nil
		}
		if len(commands) == 1 && direct != nil {
			return append([]string(nil), direct...)
		}
		return []string{"/bin/sh", "-ec", strings.Join(commands, "\n")}
	}

	if d.has("Install") {
		return []string{"pnpm", "install", "--offline", "--frozen-lockfile"}
	}
	return nil
}

// allowlist is the union of the nodes' declared destinations; the Playwright
// browser builds install with the Install node, so its declaration names
// their hosts.
func (d dependencyLayer) allowlist() []string {
	hosts := map[string]bool{}
	for _, node := range d.Nodes {
		for _, host := range node.Destinations {
			hosts[host] = true
		}
	}
	return sortedKeys(hosts)
}

func (d dependencyLayer) script() string {
	var s strings.Builder
	fmt.Fprintf(&s, `set -eEuo pipefail
exec 3>&1 4>&2 >>/var/tmp/layer.log 2>&1
trap 'tail -60 /var/tmp/layer.log >&4' ERR
set -a; eval "$(python3 -c 'import json,shlex; [print(k+"="+shlex.quote(v)) for k,v in json.load(open("/opt/smithers/env.json")).items()]')"; set +a
mkdir -p %[1]s/prepare/src
cd %[1]s/prepare/src
`, cacheRoot)
	for _, install := range d.Installs {
		if len(install.Command) > 0 && install.Command[0] == "cargo" {
			s.WriteString("for manifest in $(find . -name Cargo.toml); do dir=$(dirname \"$manifest\"); mkdir -p \"$dir/src\"; touch \"$dir/src/lib.rs\" \"$dir/src/main.rs\"; done\n")
		}
		if len(install.Command) >= 4 && install.Command[0] == "python" {
			s.WriteString("python -m pip wheel --wheel-dir \"$PIP_FIND_LINKS\" " + shellArgv(install.Command[4:]) + "\n")
			continue // Only wheels enter the shared layer; each workspace installs its own site.
		}
		argv := append([]string(nil), install.Command...)
		if len(argv) > 0 {
			switch argv[0] {
			case "npm", "pnpm", "yarn", "bun":
				argv = append(argv, "--ignore-scripts")
			}
		}
		command := shellArgv(argv)
		if len(install.Command) > 0 && install.Command[0] == "uv" {
			command += " --no-install-project"
			// Root-project sources belong to the checkout. Warm only its build
			// requirements here so an offline checkout can run its backend.
			if len(d.UVBuildRequirements) > 0 {
				s.WriteString(shellArgv(append([]string{"uv", "pip", "install", "--python", "python", "--target", cacheRoot + "/prepare/build-system"}, d.UVBuildRequirements...)) + "\n")
			}
		}
		if len(install.Command) > 0 && install.Command[0] == "go" {
			command = "GOPROXY=https://proxy.golang.org GOFLAGS=-mod=mod " + command
		}
		s.WriteString(command + "\n")
	}
	if d.has("Install") {
		// The offline install proves the store is complete for the lockfile
		// and gives tool nodes the packages they run from.
		s.WriteString("pnpm fetch --reporter=append-only\npnpm install --offline --frozen-lockfile --ignore-scripts --reporter=append-only\necho \"inventory pnpm-store $(du -sh $pnpm_config_store_dir | cut -f1)\" >&3\n")
	}
	if len(d.DprintPlugins) > 0 && d.Dprint != "" {
		warm, _ := json.Marshal(map[string]any{"plugins": d.DprintPlugins})
		fmt.Fprintf(&s, "printf '%%s' %s > /var/tmp/dprint-warm.json\n(cd %s && pnpm exec dprint output-resolved-config --config /var/tmp/dprint-warm.json >/dev/null)\necho \"inventory dprint-plugins %d\" >&3\n",
			shellQuote(string(warm)), shellQuote(d.Dprint), len(d.DprintPlugins))
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
		fmt.Fprintf(&s, "(mkdir -p /var/tmp/playwright && cd /var/tmp/playwright && npx --yes playwright@%s install chromium)\n", version)
	}
	if len(d.Playwright) > 0 {
		s.WriteString("echo \"inventory browsers $(ls $PLAYWRIGHT_BROWSERS_PATH | tr '\\n' ' ')\" >&3\n")
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
	fmt.Fprintf(&s, "cd /; rm -rf %[1]s/prepare /var/tmp/layer.log\nexec 1>&3\n", cacheRoot)
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

func withAptDestinations(hosts []string) []string {
	set := map[string]bool{}
	for _, host := range hosts {
		set[host] = true
	}
	for _, host := range []string{"deb.debian.org", "security.debian.org", "cdn-fastly.deb.debian.org", "debian.map.fastly.net", "debian.map.fastlydns.net", "dualstack.k.sni.global.fastly.net"} {
		set[host] = true
	}
	return sortedKeys(set)
}

func sortedDownloadKeys(downloads map[string]download) []string {
	keys := make([]string, 0, len(downloads))
	for key := range downloads {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func shellArgv(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = shellQuote(arg)
	}
	return strings.Join(quoted, " ")
}
