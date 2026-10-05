package microsandbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// layerSnapshot names a Smithers layer snapshot (environments.layerName):
// its kind and the first eight hex digits of its install's owner.
var layerSnapshot = regexp.MustCompile(`smthrs-(?:tc|dp)-([0-9a-f]{8})-[0-9a-f]{20}`)

// installMachine names a Smithers machine of any kind (runtime.machineName,
// layer prepare and verify machines) and its install's owner prefix.
var installMachine = regexp.MustCompile(`^smthrs-(?:ws|prep|vfy)-([0-9a-f]{8})-`)

// SnapshotMinAge keeps a snapshot younger than an hour: a layer is
// snapshotted before its record is written.
const SnapshotMinAge = time.Hour

// SnapshotCollectReport is the evidence of one snapshot collection.
type SnapshotCollectReport struct {
	Removed []string
	// Kept names each layer snapshot kept and why.
	Kept            map[string]string
	FreeBytesBefore int64
	FreeBytesAfter  int64
}

// CollectSnapshots removes the Smithers layer snapshots no install on this
// host still references. roots are install state roots (`<data>/microvm`).
// A layer snapshot is kept while any file of any root names it (a layer
// record, a workspace's metadata, a cold snapshot record), while any machine
// of its install exists (running or stopped), or while it is younger than
// minAge. Everything else is a leak: an install whose state root is gone, or
// a snapshot its own install no longer records. Only layer snapshots are ever
// touched, never with force.
func CollectSnapshots(ctx context.Context, config Config, roots []string, minAge time.Duration) (SnapshotCollectReport, error) {
	report := SnapshotCollectReport{Kept: map[string]string{}}
	binary, verify, err := startupChecks(config)
	if err != nil {
		return report, err
	}
	client, err := runtimeCLI(binary, verify)
	if err != nil {
		return report, err
	}
	if err := client.qualify(ctx); err != nil {
		return report, err
	}
	return collectSnapshots(ctx, client, roots, minAge, time.Now())
}

func collectSnapshots(ctx context.Context, client *cli, roots []string, minAge time.Duration, now time.Time) (SnapshotCollectReport, error) {
	report := SnapshotCollectReport{Kept: map[string]string{}}
	host := &Runtime{cli: client}
	report.FreeBytesBefore, _ = host.freeBytes()
	referenced := map[string]bool{}
	for _, root := range roots {
		names, err := rootReferences(root)
		if err != nil {
			return report, err
		}
		for _, name := range names {
			referenced[name] = true
		}
	}
	machines, err := client.listSandboxes(ctx, nil)
	if err != nil {
		return report, err
	}
	live := map[string]bool{}
	for _, machine := range machines {
		if match := installMachine.FindStringSubmatch(machine.Name); match != nil {
			live[match[1]] = true
		}
	}
	snapshots, err := client.listSnapshots(ctx)
	if err != nil {
		return report, err
	}
	// Decide every layer snapshot first; any other snapshot is kept.
	collect := map[string]snapshotRecord{}
	keptDigests := map[string]bool{}
	for _, snapshot := range snapshots {
		name := ""
		if snapshot.Name != nil {
			name = *snapshot.Name
		}
		match := layerSnapshot.FindStringSubmatch(name)
		switch {
		case match == nil || match[0] != name:
			keptDigests[snapshot.Digest] = true
			continue
		case referenced[name]:
			report.Kept[name] = "referenced"
		case live[match[1]]:
			report.Kept[name] = "its install has a machine"
		case now.Sub(snapshot.CreatedAt) < minAge:
			report.Kept[name] = "younger than " + minAge.String()
		default:
			collect[name] = snapshot
			continue
		}
		keptDigests[snapshot.Digest] = true
	}
	// A kept snapshot keeps the snapshot it was taken on top of.
	for changed := true; changed; {
		changed = false
		for _, snapshot := range snapshots {
			if !keptDigests[snapshot.Digest] || snapshot.ParentDigest == nil {
				continue
			}
			for name, parent := range collect {
				if parent.Digest == *snapshot.ParentDigest {
					report.Kept[name] = "a kept snapshot is taken on top of it"
					keptDigests[parent.Digest] = true
					delete(collect, name)
					changed = true
				}
			}
		}
	}
	// Children go before the snapshots they were taken on top of.
	var errs []error
	for len(collect) > 0 {
		var ready []string
		for name, snapshot := range collect {
			parentOfAnother := false
			for _, other := range collect {
				if other.ParentDigest != nil && *other.ParentDigest == snapshot.Digest {
					parentOfAnother = true
				}
			}
			if !parentOfAnother {
				ready = append(ready, name)
			}
		}
		if len(ready) == 0 {
			errs = append(errs, errors.New("snapshot parents form a cycle"))
			break
		}
		sort.Strings(ready)
		for _, name := range ready {
			delete(collect, name)
			removeCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			err := client.removeSnapshot(removeCtx, name)
			cancel()
			if err != nil {
				errs = append(errs, err)
				continue
			}
			report.Removed = append(report.Removed, name)
		}
	}
	sort.Strings(report.Removed)
	report.FreeBytesAfter, _ = host.freeBytes()
	return report, errors.Join(errs...)
}

// rootReferences lists every layer snapshot an install's state names: its
// layer records, its workspaces' metadata and its cold snapshot records. A
// missing root names nothing; an unreadable one is an error, so nothing it
// might reference is removed.
func rootReferences(root string) ([]string, error) {
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var files []string
	for _, pattern := range []string{"layers/*.json", "workspaces/*/metadata.json", "snapshots/*"} {
		matches, err := filepath.Glob(filepath.Join(root, pattern))
		if err != nil {
			return nil, err
		}
		files = append(files, matches...)
	}
	var names []string
	for _, file := range files {
		contents, err := os.ReadFile(file)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		names = append(names, layerSnapshot.FindAllString(string(contents), -1)...)
		// A record names its layer by file name too.
		names = append(names, layerSnapshot.FindAllString(strings.TrimSuffix(filepath.Base(file), ".json"), -1)...)
	}
	return names, nil
}
