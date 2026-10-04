package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

func TestParseFactoryMachine(t *testing.T) {
	for _, tc := range []struct {
		name, projection string
		want             MythicalMachine
		invalid          string
	}{
		{name: "no projection"},
		{name: "no machine block", projection: `{"github":{"mirror":"pull"}}`},
		{name: "null machine block", projection: `{"machine":null}`},
		{name: "empty machine block", projection: `{"machine":{}}`},
		{name: "everything", projection: `{"machine":{"vcpus":4,"memoryMiB":8192,"tools":["go","pnpm","cargo-nextest","g++"]}}`,
			want: MythicalMachine{VCPUs: 4, MemoryMiB: 8192, Tools: []string{"go", "pnpm", "cargo-nextest", "g++"}}},
		{name: "bounds are inclusive", projection: `{"machine":{"vcpus":1024,"memoryMiB":4194304}}`,
			want: MythicalMachine{VCPUs: 1024, MemoryMiB: 4 << 20}},
		{name: "smallest machine", projection: `{"machine":{"vcpus":1,"memoryMiB":1}}`, want: MythicalMachine{VCPUs: 1, MemoryMiB: 1}},
		{name: "not JSON", projection: `{`, invalid: ".smithers/factory.json is not valid JSON"},
		{name: "zero vcpus", projection: `{"machine":{"vcpus":0}}`, invalid: "machine.vcpus must be between 1 and 1024"},
		{name: "too many vcpus", projection: `{"machine":{"vcpus":1025}}`, invalid: "machine.vcpus must be between 1 and 1024"},
		{name: "negative memory", projection: `{"machine":{"memoryMiB":-1}}`, invalid: "machine.memoryMiB must be between 1 and 4194304"},
		{name: "too much memory", projection: `{"machine":{"memoryMiB":4194305}}`, invalid: "machine.memoryMiB must be between 1 and 4194304"},
		{name: "memory past int32", projection: `{"machine":{"memoryMiB":9999999999}}`, invalid: "machine.memoryMiB must be between 1 and 4194304"},
		{name: "fractional vcpus", projection: `{"machine":{"vcpus":1.5}}`, invalid: ".smithers/factory.json is not valid JSON"},
		{name: "tool with a path", projection: `{"machine":{"tools":["/bin/sh"]}}`, invalid: `machine.tools entry "/bin/sh" is not a tool name`},
		{name: "tool with a space", projection: `{"machine":{"tools":["rm -rf"]}}`, invalid: `machine.tools entry "rm -rf" is not a tool name`},
		{name: "empty tool", projection: `{"machine":{"tools":[""]}}`, invalid: `machine.tools entry "" is not a tool name`},
		{name: "duplicate tool", projection: `{"machine":{"tools":["go","go"]}}`, invalid: `machine.tools names "go" twice`},
		{name: "too many tools", projection: `{"machine":{"tools":[` + strings.Repeat(`"t",`, 64) + `"t"]}}`, invalid: "machine.tools names more than 64 tools"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseFactoryMachine([]byte(tc.projection))
			if tc.invalid != "" {
				var invalid factoryMachineInvalid
				require.ErrorAs(t, err, &invalid)
				assert.Contains(t, invalid.Error(), tc.invalid)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestPlaceMythicalLane(t *testing.T) {
	image := &runtimeports.SandboxEnvironmentImage{ID: "img-7", RepositoryID: pgtype.Int8{Int64: 7, Valid: true}, Kind: "vm",
		SourceRevision: "rev-1", ClosureHash: strings.Repeat("c", 32), Image: "registry/env:" + strings.Repeat("c", 32)}
	offer := mythicalMachineOffer{VCPUs: 4, MemoryMiB: 8192, NixOS: true}
	built := offer
	built.Image, built.ImageDigest = image, "d1"
	stale := built
	stale.ImageDigest = "d0"
	unknown := built
	unknown.ImageDigest = ""
	noNixOS := built
	noNixOS.NixOS = false
	env := MythicalMachine{Revision: strings.Repeat("a", 40), Environment: ".smithers/environment.nix", EnvironmentDigest: "d1"}
	withTools := env
	withTools.Tools = []string{"go"}
	large := env
	large.VCPUs = 64
	for _, tc := range []struct {
		name     string
		declared MythicalMachine
		offer    mythicalMachineOffer
		want     MythicalPlacement
	}{
		{name: "nothing declared runs on the default guest", offer: offer,
			want: MythicalPlacement{Kind: "container", VCPUs: 4, MemoryMiB: 8192}},
		{name: "nothing declared ignores a registered image", offer: built,
			want: MythicalPlacement{Kind: "container", VCPUs: 4, MemoryMiB: 8192}},
		{name: "a declared environment boots its image", declared: withTools, offer: built,
			want: MythicalPlacement{Declared: withTools, Kind: "vm", VCPUs: 4, MemoryMiB: 8192,
				ImageID: "img-7", Image: image.Image, ClosureHash: image.ClosureHash, ImageRevision: "rev-1"}},
		{name: "needs equal to the machine fit", declared: MythicalMachine{VCPUs: 4, MemoryMiB: 8192}, offer: offer,
			want: MythicalPlacement{Declared: MythicalMachine{VCPUs: 4, MemoryMiB: 8192}, Kind: "container", VCPUs: 4, MemoryMiB: 8192}},
		{name: "an unbuilt environment is refused", declared: env, offer: offer,
			want: MythicalPlacement{Declared: env, Refusal: placementEnvironmentUnbuilt,
				Reason: "no machine is built from .smithers/environment.nix yet; register its NixOS image"}},
		{name: "an image built from an older environment is refused", declared: env, offer: stale,
			want: MythicalPlacement{Declared: env, Refusal: placementEnvironmentStale,
				Reason: "the registered NixOS image was built from another .smithers/environment.nix; register one built at aaaaaaaaaaaa"}},
		{name: "an image of unknown origin is refused", declared: env, offer: unknown,
			want: MythicalPlacement{Declared: env, Refusal: placementEnvironmentStale,
				Reason: "the registered NixOS image was built from another .smithers/environment.nix; register one built at aaaaaaaaaaaa"}},
		{name: "lanes that cannot boot NixOS are refused", declared: env, offer: noNixOS,
			want: MythicalPlacement{Declared: env, Refusal: placementEnvironmentUnsupported, Reason: "lane machines here cannot boot a NixOS environment"}},
		{name: "nothing declared needs no NixOS", offer: noNixOS,
			want: MythicalPlacement{Kind: "container", VCPUs: 4, MemoryMiB: 8192}},
		{name: "tools need an environment", declared: MythicalMachine{Tools: []string{"go", "pnpm"}}, offer: built,
			want: MythicalPlacement{Declared: MythicalMachine{Tools: []string{"go", "pnpm"}}, Refusal: placementToolsWithoutEnvironment,
				Reason: "it needs go, pnpm and the repository declares no .smithers/environment.nix to provide them"}},
		{name: "one vCPU too many", declared: MythicalMachine{VCPUs: 5}, offer: offer,
			want: MythicalPlacement{Declared: MythicalMachine{VCPUs: 5}, Refusal: placementMachineTooSmall, Reason: "it needs 5 vCPUs and lane machines here have 4"}},
		{name: "one MiB too many", declared: MythicalMachine{MemoryMiB: 8193}, offer: offer,
			want: MythicalPlacement{Declared: MythicalMachine{MemoryMiB: 8193}, Refusal: placementMachineTooSmall,
				Reason: "it needs 8193 MiB of memory and lane machines here have 8192 MiB"}},
		{name: "a missing environment is reported before size", declared: large, offer: offer,
			want: MythicalPlacement{Declared: large, Refusal: placementEnvironmentUnbuilt,
				Reason: "no machine is built from .smithers/environment.nix yet; register its NixOS image"}},
		{name: "a stale environment is reported before size", declared: large, offer: stale,
			want: MythicalPlacement{Declared: large, Refusal: placementEnvironmentStale,
				Reason: "the registered NixOS image was built from another .smithers/environment.nix; register one built at aaaaaaaaaaaa"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, placeMythicalLane(tc.declared, tc.offer))
		})
	}
}

// machineHost serves one commit of a repository: its factory projection and
// whether it carries .smithers/environment.nix.
type machineHost struct {
	bookmarks   []repohost.Bookmark
	projection  *string
	environment bool
	// environments overrides the environment.nix content at a commit ("" is
	// no file there).
	environments map[string]string
	// fail fails reads of this path (or the bookmark listing for "bookmarks"),
	// failCommit every read at that commit.
	fail       string
	failCommit string
	binary     string
	commits    []string
}

func (h *machineHost) ListBookmarks(context.Context, string, string, string, int) ([]repohost.Bookmark, string, error) {
	if h.fail == "bookmarks" {
		return nil, "", errors.New("repo host unavailable")
	}
	return h.bookmarks, "", nil
}

func (h *machineHost) GetFileAtChange(_ context.Context, _, _, commit, path string) (repohost.FileContent, error) {
	h.commits = append(h.commits, commit)
	switch {
	case path == h.fail || commit == h.failCommit:
		return repohost.FileContent{}, errors.New("repo host unavailable")
	case path == h.binary:
		return repohost.FileContent{Encoding: "base64"}, nil
	case path == factoryProjectionPath && h.projection != nil:
		return repohost.FileContent{Content: *h.projection}, nil
	case path == defaultWorkspaceEnvironmentSource && h.environments != nil && h.environments[commit] != "":
		return repohost.FileContent{Content: h.environments[commit]}, nil
	case path == defaultWorkspaceEnvironmentSource && h.environments != nil:
		return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
	case path == defaultWorkspaceEnvironmentSource && h.environment:
		return repohost.FileContent{Content: testEnvironmentNix}, nil
	}
	return repohost.FileContent{}, &repohost.StatusError{StatusCode: 404}
}

// testEnvironmentNix is the .smithers/environment.nix machineHost serves.
const testEnvironmentNix = "{ pkgs, ... }: {}"

func TestReadRepositoryMachine(t *testing.T) {
	ctx := context.Background()
	main := []repohost.Bookmark{{Name: "other", TargetCommitID: "c0"}, {Name: "main", TargetCommitID: "c1"}}
	projection := `{"machine":{"vcpus":2,"tools":["go"]}}`
	bad := `{"machine":{"vcpus":0}}`

	got, err := readRepositoryMachine(ctx, &machineHost{bookmarks: main, projection: &projection, environment: true}, "o", "r", "main")
	require.NoError(t, err)
	assert.Equal(t, MythicalMachine{Revision: "c1", Environment: ".smithers/environment.nix", EnvironmentDigest: environmentDigest(testEnvironmentNix),
		VCPUs: 2, Tools: []string{"go"}}, got)
	assert.Equal(t, "a001f654c81bb7f4b237cdcbd01f0ca32837b19c93184d779f2d76dbec11847a", got.EnvironmentDigest, "the SHA-256 of the file's content")

	host := &machineHost{bookmarks: main}
	got, err = readRepositoryMachine(ctx, host, "o", "r", "main")
	require.NoError(t, err)
	assert.Equal(t, MythicalMachine{Revision: "c1"}, got, "no projection and no environment declare nothing")
	assert.Equal(t, []string{"c1", "c1"}, host.commits, "both files are read at the bookmark's one commit")

	got, err = readRepositoryMachine(ctx, &machineHost{bookmarks: main[:1], projection: &projection, environment: true}, "o", "r", "main")
	require.NoError(t, err)
	assert.Equal(t, MythicalMachine{}, got, "no bookmark declares nothing")

	_, err = readRepositoryMachine(ctx, &machineHost{bookmarks: main, projection: &bad}, "o", "r", "main")
	var invalid factoryMachineInvalid
	require.ErrorAs(t, err, &invalid)

	for _, fail := range []string{"bookmarks", factoryProjectionPath, defaultWorkspaceEnvironmentSource} {
		_, err = readRepositoryMachine(ctx, &machineHost{bookmarks: main, projection: &projection, fail: fail}, "o", "r", "main")
		require.Error(t, err, fail)
		assert.False(t, errors.As(err, &invalid), "an unreachable host is never the owner's fault")
	}
	_, err = readRepositoryMachine(ctx, &machineHost{bookmarks: main, binary: defaultWorkspaceEnvironmentSource}, "o", "r", "main")
	require.EqualError(t, err, ".smithers/environment.nix is not readable text")
	_, err = readRepositoryMachine(ctx, &machineHost{bookmarks: []repohost.Bookmark{{Name: "main"}}}, "o", "r", "main")
	require.EqualError(t, err, "main names no commit")
	_, err = readRepositoryMachine(ctx, nil, "o", "r", "main")
	require.EqualError(t, err, "repository policy reader unavailable")
}

// An image's environment is identified by the environment.nix content at
// the commit its registrar recorded.
func TestImageEnvironmentDigest(t *testing.T) {
	ctx := context.Background()
	declaredAt, builtAt, bare := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("e", 40)
	declared := MythicalMachine{Revision: declaredAt, Environment: defaultWorkspaceEnvironmentSource, EnvironmentDigest: environmentDigest("new")}
	host := &machineHost{environments: map[string]string{declaredAt: "new", builtAt: "old", strings.Repeat("c", 40): "new"}}
	for _, tc := range []struct {
		name, revision, want string
	}{
		{name: "built at the declared commit", revision: declaredAt, want: environmentDigest("new")},
		{name: "built from the same file earlier", revision: strings.Repeat("c", 40), want: environmentDigest("new")},
		{name: "built from an older file", revision: builtAt, want: environmentDigest("old")},
		{name: "built where no file was", revision: bare},
		{name: "a revision that is no commit", revision: "rev-1"},
		{name: "no revision"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host.commits = nil
			got, err := imageEnvironmentDigest(ctx, host, "o", "r", declared, runtimeports.SandboxEnvironmentImage{SourceRevision: tc.revision})
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
			if tc.revision == declaredAt || !isImmutableGitObjectID(tc.revision) {
				assert.Empty(t, host.commits, "nothing is read")
			}
		})
	}
	_, err := imageEnvironmentDigest(ctx, &machineHost{failCommit: builtAt}, "o", "r", declared, runtimeports.SandboxEnvironmentImage{SourceRevision: builtAt})
	require.Error(t, err)
}

// fixedEnvironmentImages is a registry with one image.
type fixedEnvironmentImages struct {
	image runtimeports.SandboxEnvironmentImage
	err   error
	kinds []string
}

func (f *fixedEnvironmentImages) Resolve(_ context.Context, _ int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	f.kinds = append(f.kinds, kind)
	return f.image, f.err
}

func (f *fixedEnvironmentImages) Pinned(_ context.Context, _ int64, kind, _ string) (runtimeports.SandboxEnvironmentImage, error) {
	f.kinds = append(f.kinds, "pinned "+kind)
	return f.image, f.err
}

func TestWorkspaceMythicalLanesOffer(t *testing.T) {
	ctx := context.Background()
	own := runtimeports.SandboxEnvironmentImage{RepositoryID: pgtype.Int8{Int64: 7, Valid: true}, Image: "registry/env:x", ClosureHash: "x"}
	base := runtimeports.SandboxEnvironmentImage{Image: "registry/base:y", ClosureHash: "y"}
	other := runtimeports.SandboxEnvironmentImage{RepositoryID: pgtype.Int8{Int64: 8, Valid: true}, Image: "registry/env:z"}
	workspaces := newWorkspaceServiceForTests(&mockWorkspaceQuerier{}, WithWorkspaceResources(6144, 3))

	images := &fixedEnvironmentImages{image: own}
	workspaces.environmentImages = images
	offer, err := NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, mythicalMachineOffer{VCPUs: 3, MemoryMiB: 6144}, offer, "no workspace runtime boots no NixOS image")
	workspaces.runtime = &pinRuntime{}
	offer, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, mythicalMachineOffer{VCPUs: 3, MemoryMiB: 6144}, offer, "a runtime without environment images offers the sized default guest")
	assert.Empty(t, images.kinds, "the registry is not consulted for lanes that cannot boot it")

	workspaces.runtime = &pinRuntime{images: true}
	workspaces.environmentImages = nil
	offer, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, mythicalMachineOffer{VCPUs: 3, MemoryMiB: 6144, NixOS: true}, offer, "no image registry offers no image")

	workspaces.environmentImages = images
	offer, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, mythicalMachineOffer{VCPUs: 3, MemoryMiB: 6144, NixOS: true, Image: &own}, offer)
	assert.Equal(t, []string{"vm"}, images.kinds)

	for name, image := range map[string]runtimeports.SandboxEnvironmentImage{"platform base": base, "another repository's": other} {
		workspaces.environmentImages = &fixedEnvironmentImages{image: image}
		offer, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
		require.NoError(t, err)
		assert.Nil(t, offer.Image, "a %s image never stands in for the repository's environment", name)
	}

	workspaces.environmentImages = &fixedEnvironmentImages{err: pkgerrors.EnvironmentImageUnavailable("none")}
	offer, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.NoError(t, err)
	assert.Nil(t, offer.Image, "no registered image is an offer without one")

	workspaces.environmentImages = &fixedEnvironmentImages{err: pkgerrors.Internal("resolve environment image: down")}
	_, err = NewWorkspaceMythicalLanes(workspaces).Offer(ctx, 7)
	require.Error(t, err)

	_, err = NewWorkspaceMythicalLanes(nil).Offer(ctx, 7)
	requireAPIErrorStatus(t, err, 500)
}

// Create boots the lane workspace on the placement's machine.
func TestWorkspaceMythicalLanesCreateBootsThePlacement(t *testing.T) {
	ctx := context.Background()
	var created []db.CreateWorkspaceParams
	workspaces := newWorkspaceServiceForTests(&mockWorkspaceQuerier{
		countActiveWorkspacesByUserFn: func(context.Context, int64) (int64, error) { return 0, nil },
		createWorkspaceFn: func(_ context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
			created = append(created, arg)
			workspace := sampleDBWorkspace("ws-lane")
			workspace.Kind = arg.Kind
			return workspace, nil
		},
	})
	lanes := NewWorkspaceMythicalLanes(workspaces)
	refuseBind := func(string) error { return errors.New("bound elsewhere") }
	vm := MythicalPlacement{Kind: "vm", ClosureHash: strings.Repeat("c", 32), ImageRevision: "rev-1"}
	_, err := lanes.Create(ctx, db.Repository{ID: 101}, "o", 1, "lane", vm, refuseBind)
	require.EqualError(t, err, "bound elsewhere")
	_, err = lanes.Create(ctx, db.Repository{ID: 101}, "o", 1, "wiki", MythicalPlacement{}, refuseBind)
	require.EqualError(t, err, "bound elsewhere")
	require.Len(t, created, 2)
	assert.Equal(t, "vm", created[0].Kind)
	assert.Equal(t, ".smithers/environment.nix", created[0].EnvironmentSource)
	assert.Equal(t, "rev-1", created[0].EnvironmentRevision)
	assert.Equal(t, strings.Repeat("c", 32), created[0].EnvironmentClosureHash)
	assert.Equal(t, "container", created[1].Kind, "the zero placement is the platform's default guest")
	assert.Empty(t, created[1].EnvironmentClosureHash)
}

// placementPolicy is the owner's projection with a machine block.
func placementPolicy(machine string) string {
	return `{"on":[],"github":{"mirror":"pull","issues":"two-way","changes":"send-upstream","maintainers":["roninjin10"],"dailyTokens":1000000000000},"machine":` + machine + `}`
}

// A TODO whose repository declares a NixOS environment runs its request,
// its verification and its review on lanes booted from that environment's
// image, and the item's receipt names the machine.
func TestMythicalTodoRunsOnTheDeclaredMachine(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	projection := placementPolicy(`{"vcpus":2,"memoryMiB":4096,"tools":["go"]}`)
	o.service.SetPolicyReader(&machineHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetCommitID: strings.Repeat("a", 40)}},
		projection: &projection, environment: true})
	image := runtimeports.SandboxEnvironmentImage{ID: "img-1", RepositoryID: pgtype.Int8{Int64: o.repoID, Valid: true}, Kind: "vm",
		SourceRevision: strings.Repeat("b", 40), ClosureHash: strings.Repeat("c", 32), Image: "registry/env:" + strings.Repeat("c", 32)}
	o.lanes.offer = &mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096, NixOS: true, Image: &image}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 70, Title: "Placed", State: "open",
		TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	o.propose(70, "placed.md")

	want := MythicalPlacement{Declared: MythicalMachine{Revision: strings.Repeat("a", 40), Environment: ".smithers/environment.nix",
		EnvironmentDigest: environmentDigest(testEnvironmentNix), VCPUs: 2, MemoryMiB: 4096, Tools: []string{"go"}}, Kind: "vm", VCPUs: 2, MemoryMiB: 4096,
		ImageID: "img-1", Image: image.Image, ClosureHash: image.ClosureHash, ImageRevision: strings.Repeat("b", 40)}
	require.GreaterOrEqual(t, len(o.lanes.placements), 2, "the request lane and the review lane")
	for _, placement := range o.lanes.placements {
		assert.Equal(t, want, placement)
	}
	view := mythicalItemView(o.item(70))
	require.NotNil(t, view.Placement)
	assert.Equal(t, want, *view.Placement)
}

// A declaration no lane machine here meets stops the TODO with a typed
// refusal before any lane is created or run launched, says why once on the
// issue, and runs once the machine exists and a person retries.
func TestMythicalTodoRefusesTheWrongMachine(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	projection := placementPolicy(`{"vcpus":8}`)
	o.service.SetPolicyReader(&machineHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetCommitID: strings.Repeat("a", 40)}}, projection: &projection})
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 71, Title: "Too big", State: "open",
		TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	o.wake()

	item := o.item(71)
	require.Equal(t, "blocked", item.State)
	assert.Equal(t, "no machine matches this repository: it needs 8 vCPUs and lane machines here have 2", item.Reason)
	assert.Equal(t, &mythicalFault{Class: "policy", Tag: "placement", Kind: mythicalFailStopped}, mythicalChecksOf(item).Fault)
	view := mythicalItemView(item)
	require.NotNil(t, view.Placement)
	assert.Equal(t, placementMachineTooSmall, view.Placement.Refusal)
	assert.Empty(t, view.Placement.Kind)
	assert.Empty(t, o.lanes.created, "no lane on the wrong machine")
	assert.Empty(t, o.launcher.requests, "no run on the wrong machine")
	o.wake()
	assert.Equal(t, []string{"#71 Smithers stopped this TODO. No machine matches what this repository declares."},
		o.github.comments, "said once")
	failure, sentence := mythicalFailureOf(item)
	assert.Equal(t, &MythicalFailureView{Kind: mythicalFailStopped, Fault: "policy"}, failure)
	assert.Equal(t, "No machine matches what this repository declares", sentence)

	// The operator boots bigger lanes; a person retries.
	o.lanes.offer = &mythicalMachineOffer{VCPUs: 8, MemoryMiB: 16384}
	_, err := o.service.retryItem(ctx, o.repoID, uuidString(item.ID))
	require.NoError(t, err)
	o.wake()
	item = o.item(71)
	require.Equal(t, "running", item.State, item.Reason)
	assert.Equal(t, "container", mythicalChecksOf(item).Placement.Kind)
	assert.EqualValues(t, 8, mythicalChecksOf(item).Placement.VCPUs)
	assert.Len(t, o.launcher.requests, 1)
}

// Each typed refusal stops the TODO; an unreadable declaration or offer is
// an outage Smithers retries, never the owner's fault.
func TestMythicalTodoPlacementFailures(t *testing.T) {
	declaredAt, builtAt := strings.Repeat("a", 40), strings.Repeat("b", 40)
	main := []repohost.Bookmark{{Name: "main", TargetCommitID: declaredAt}}
	built := &mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096, NixOS: true, Image: &runtimeports.SandboxEnvironmentImage{ID: "img-1", Kind: "vm",
		SourceRevision: builtAt, ClosureHash: strings.Repeat("c", 32), Image: "registry/env:" + strings.Repeat("c", 32)}}
	edited := map[string]string{declaredAt: "{ pkgs, ... }: { environment.systemPackages = [ pkgs.go ]; }", builtAt: testEnvironmentNix}
	for _, tc := range []struct {
		name    string
		host    *machineHost
		offer   *mythicalMachineOffer
		offErr  error
		refusal string
		outage  string
	}{
		{name: "unbuilt environment", host: &machineHost{bookmarks: main, environment: true}, offer: &mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096, NixOS: true},
			refusal: placementEnvironmentUnbuilt},
		{name: "unsupported environment", host: &machineHost{bookmarks: main, environment: true}, refusal: placementEnvironmentUnsupported},
		{name: "stale image", host: &machineHost{bookmarks: main, environments: edited}, offer: built, refusal: placementEnvironmentStale},
		{name: "image built where no environment was", host: &machineHost{bookmarks: main, environments: map[string]string{declaredAt: testEnvironmentNix}},
			offer: built, refusal: placementEnvironmentStale},
		{name: "unreadable image environment", host: &machineHost{bookmarks: main, environment: true, failCommit: builtAt}, offer: built,
			outage: "the image's environment could not be read"},
		{name: "tools without environment", host: &machineHost{bookmarks: main}, refusal: placementToolsWithoutEnvironment},
		{name: "invalid machine block", host: &machineHost{bookmarks: main}, refusal: placementMachineInvalid},
		{name: "unreadable environment", host: &machineHost{bookmarks: main, fail: defaultWorkspaceEnvironmentSource},
			outage: "the repository's machine could not be read"},
		{name: "unreadable offer", host: &machineHost{bookmarks: main}, offErr: errors.New("images down"), outage: "the lane machines could not be read"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := newMythicalOrchestration(t)
			ctx := context.Background()
			machine := `{}`
			switch tc.refusal {
			case placementToolsWithoutEnvironment:
				machine = `{"tools":["go"]}`
			case placementMachineInvalid:
				machine = `{"vcpus":0}`
			}
			projection := placementPolicy(machine)
			tc.host.projection = &projection
			o.service.SetPolicyReader(tc.host)
			o.lanes.offer, o.lanes.offerErr = tc.offer, tc.offErr
			require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 72, Title: "Placement", State: "open",
				TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
			o.wake()
			item := o.item(72)
			checks := mythicalChecksOf(item)
			assert.Empty(t, o.lanes.created)
			assert.Empty(t, o.launcher.requests)
			if tc.refusal != "" {
				require.Equal(t, "blocked", item.State)
				assert.Equal(t, &mythicalFault{Class: "policy", Tag: "placement", Kind: mythicalFailStopped}, checks.Fault)
				require.NotNil(t, checks.Placement)
				assert.Equal(t, tc.refusal, checks.Placement.Refusal)
				assert.True(t, strings.HasPrefix(item.Reason, "no machine matches this repository: "), item.Reason)
				return
			}
			assert.Equal(t, "queued", item.State)
			assert.Equal(t, &mythicalFault{Class: "infra", Tag: "launch", Kind: mythicalFailProvisioning}, checks.Fault)
			assert.Equal(t, 1, checks.Outages)
			assert.Contains(t, item.Reason, tc.outage)
			assert.Nil(t, checks.Placement)
		})
	}
}

func TestWorkspaceMythicalLanesPlaced(t *testing.T) {
	ctx := context.Background()
	closure := strings.Repeat("c", 32)
	vm := MythicalPlacement{Kind: "vm", ClosureHash: closure}
	for _, tc := range []struct {
		name      string
		workspace db.Workspace
		err       error
		placement MythicalPlacement
		want      bool
		wantErr   bool
	}{
		{name: "same container", workspace: db.Workspace{Kind: "container"}, want: true},
		{name: "same closure", workspace: db.Workspace{Kind: "vm", EnvironmentClosureHash: closure}, placement: vm, want: true},
		{name: "another closure", workspace: db.Workspace{Kind: "vm", EnvironmentClosureHash: strings.Repeat("d", 32)}, placement: vm},
		{name: "container for a NixOS placement", workspace: db.Workspace{Kind: "container"}, placement: vm},
		{name: "NixOS lane for the default guest", workspace: db.Workspace{Kind: "vm", EnvironmentClosureHash: closure}},
		{name: "deleted", workspace: db.Workspace{Kind: "container", DeletedAt: pgtype.Timestamptz{Valid: true}}},
		{name: "gone", err: pgx.ErrNoRows},
		{name: "unreadable", err: errors.New("down"), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lanes := NewWorkspaceMythicalLanes(newWorkspaceServiceForTests(&mockWorkspaceQuerier{
				getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return tc.workspace, tc.err },
			}))
			got, err := lanes.Placed(ctx, "ws", tc.placement)
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
	_, err := NewWorkspaceMythicalLanes(nil).Placed(ctx, "ws", vm)
	requireAPIErrorStatus(t, err, 500)
}

// A lane bound by an attempt whose launch was lost is recovered only while it
// runs on the machine the retry is placed on; otherwise it is retired and a
// lane on the right machine replaces it.
func TestMythicalTodoRecoversOnlyALaneOnItsMachine(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	main := []repohost.Bookmark{{Name: "main", TargetCommitID: strings.Repeat("a", 40)}}
	projection := placementPolicy(`{}`)
	host := &machineHost{bookmarks: main, projection: &projection}
	o.service.SetPolicyReader(host)
	o.launcher.fail = 1
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 73, Title: "Recover", State: "open",
		TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	require.Len(t, o.lanes.created, 1, "the lost launch left its lane bound")
	assert.Equal(t, "container", o.lanes.placements[0].Kind)
	require.Empty(t, o.launcher.requests)

	// The owner declares a NixOS environment before the retry.
	host.environment = true
	image := runtimeports.SandboxEnvironmentImage{ID: "img-1", RepositoryID: pgtype.Int8{Int64: o.repoID, Valid: true}, Kind: "vm",
		SourceRevision: strings.Repeat("b", 40), ClosureHash: strings.Repeat("c", 32), Image: "registry/env:" + strings.Repeat("c", 32)}
	o.lanes.offer = &mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096, NixOS: true, Image: &image}
	o.wake()
	item := o.item(73)
	require.Equal(t, "running", item.State, item.Reason)
	require.Len(t, o.lanes.created, 2)
	assert.Equal(t, []string{o.lanes.created[0]}, o.lanes.deleted, "the container lane is retired")
	assert.Equal(t, "vm", o.lanes.placements[1].Kind)
	assert.Equal(t, o.lanes.created[1], item.WorkspaceID)
	assert.Equal(t, "vm", mythicalChecksOf(item).Placement.Kind)
	require.Len(t, o.launcher.requests, 1)
}

// A lane whose box lacks a tool the repository declares stops its TODO with
// the placement refusal, once, and is not retried onto the same machine.
func TestMythicalTodoStopsOnABoxWithoutItsTools(t *testing.T) {
	o := newMythicalOrchestration(t)
	ctx := context.Background()
	declaredAt := strings.Repeat("a", 40)
	projection := placementPolicy(`{"tools":["go","pnpm"]}`)
	o.service.SetPolicyReader(&machineHost{bookmarks: []repohost.Bookmark{{Name: "main", TargetCommitID: declaredAt}},
		projection: &projection, environment: true})
	image := runtimeports.SandboxEnvironmentImage{ID: "img-1", RepositoryID: pgtype.Int8{Int64: o.repoID, Valid: true}, Kind: "vm",
		SourceRevision: declaredAt, ClosureHash: strings.Repeat("c", 32), Image: "registry/env:" + strings.Repeat("c", 32)}
	o.lanes.offer = &mythicalMachineOffer{VCPUs: 2, MemoryMiB: 4096, NixOS: true, Image: &image}
	require.NoError(t, seedMythicalIssue(o.service, ctx, o.repoID, mythicalIssue{Number: 74, Title: "Tools", State: "open",
		TextByMaintainer: true, Labels: []string{"todo"}}, maintainerTodo))
	o.wake()
	item := o.item(74)
	require.Equal(t, "running", item.State, item.Reason)

	tools, err := o.service.LaneTools(ctx, item.WorkspaceID)
	require.NoError(t, err)
	assert.Equal(t, []string{"go", "pnpm"}, tools, "the lane's box must have what its placement declares")
	tools, err = o.service.LaneTools(ctx, uuid.NewString())
	require.NoError(t, err)
	assert.Empty(t, tools, "a workspace that is no lane needs nothing")

	request := o.launcher.last("coding/request")
	require.NoError(t, o.service.ProjectFlowRuntime(ctx, flowdispatch.ProjectionUpdate{State: jobs.StateFailed,
		Checkpoint: flowdispatch.RuntimeCheckpoint{Projection: request.Projection, FailureCode: placementToolsMissing}}))
	o.wake()
	item = o.item(74)
	require.Equal(t, "blocked", item.State, item.Reason)
	assert.Equal(t, &mythicalFault{Class: "policy", Tag: "placement", Kind: mythicalFailStopped}, mythicalChecksOf(item).Fault)
	o.wake()
	assert.Len(t, o.launcher.requests, 1, "no retry on the same machine")
	assert.Equal(t, []string{"#74 Smithers stopped this TODO. No machine matches what this repository declares."}, o.github.comments)
}

// Every other launch failure code stays an outage Smithers retries.
func TestMythicalRunOutcomeStopsOnlyAtMissingTools(t *testing.T) {
	failed := func(code string) flowdispatch.ProjectionUpdate {
		return flowdispatch.ProjectionUpdate{State: jobs.StateFailed, Checkpoint: flowdispatch.RuntimeCheckpoint{FailureCode: code}}
	}
	assert.Equal(t, "stopped: policy: placement", mythicalRunOutcome("request", failed("environment_tools_missing")))
	assert.Equal(t, "outage: infra: environment_image_unavailable", mythicalRunOutcome("request", failed("environment_image_unavailable")))
}
