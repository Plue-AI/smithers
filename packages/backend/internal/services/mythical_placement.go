package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/runtimeports"
)

// A factory TODO's lane runs on a machine that matches what the repository
// declares (#2784): the NixOS environment its .smithers/environment.nix
// builds, and the `machine` block of its committed factory projection
// (S.Factory({ machine: { vcpus, memoryMiB, tools } })). The declaration is
// read at the default bookmark's commit, the same snapshot the factory's
// policy comes from. A machine the deployment cannot offer stops the TODO
// with a typed refusal; it never runs on the wrong machine.

// Placement refusals: the typed reasons a lane is not placed.
const (
	// placementMachineInvalid: the committed machine block is unreadable.
	placementMachineInvalid = "machine_invalid"
	// placementEnvironmentUnbuilt: the repository declares a NixOS
	// environment and no image built from it is registered.
	placementEnvironmentUnbuilt = "environment_unbuilt"
	// placementToolsWithoutEnvironment: tools are declared but no NixOS
	// environment provides them.
	placementToolsWithoutEnvironment = "tools_without_environment"
	// placementMachineTooSmall: the declared vCPUs or memory exceed the
	// machine this deployment boots lanes on.
	placementMachineTooSmall = "machine_too_small"
	// placementEnvironmentUnsupported: the repository declares a NixOS
	// environment and this deployment's lanes cannot boot one.
	placementEnvironmentUnsupported = "environment_unsupported"
	// placementEnvironmentStale: the registered image was built from another
	// .smithers/environment.nix than the one declared.
	placementEnvironmentStale = "environment_stale"
	// placementToolsMissing: the booted machine lacks a declared tool
	// (WorkspaceService.PrepareBoxHost); the run's failure code.
	placementToolsMissing = "environment_tools_missing"
)

// Declaration bounds: generous for any real machine, small enough to keep a
// hostile projection out of the item's receipt.
const (
	factoryMachineMaxVCPUs     = 1024
	factoryMachineMaxMemoryMiB = 4 << 20
	factoryMachineMaxTools     = 64
)

// factoryMachineToolPattern is one executable name on PATH.
var factoryMachineToolPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)

// MythicalMachine is what a repository declares about the machine its
// factory work needs, read at one commit.
type MythicalMachine struct {
	// Revision is the commit the declaration was read at.
	Revision string `json:"revision,omitempty"`
	// Environment is the declared NixOS environment's path, or "" when the
	// commit carries none, and EnvironmentDigest the SHA-256 of its content.
	Environment       string   `json:"environment,omitempty"`
	EnvironmentDigest string   `json:"environmentDigest,omitempty"`
	VCPUs             int32    `json:"vcpus,omitempty"`
	MemoryMiB         int32    `json:"memoryMiB,omitempty"`
	Tools             []string `json:"tools,omitempty"`
}

// factoryMachineInvalid is a committed machine block the factory refuses to
// place from: the owner's to fix, never retried as an outage.
type factoryMachineInvalid struct{ reason string }

func (e factoryMachineInvalid) Error() string { return e.reason }

// parseFactoryMachine reads a factory projection's machine block. A missing
// projection or block declares nothing.
func parseFactoryMachine(projection []byte) (MythicalMachine, error) {
	var machine MythicalMachine
	if len(projection) == 0 {
		return machine, nil
	}
	var factory struct {
		Machine *struct {
			VCPUs     *int64   `json:"vcpus"`
			MemoryMiB *int64   `json:"memoryMiB"`
			Tools     []string `json:"tools"`
		} `json:"machine"`
	}
	if err := json.Unmarshal(projection, &factory); err != nil {
		return machine, factoryMachineInvalid{factoryProjectionPath + " is not valid JSON"}
	}
	if factory.Machine == nil {
		return machine, nil
	}
	declared := factory.Machine
	if declared.VCPUs != nil {
		if *declared.VCPUs < 1 || *declared.VCPUs > factoryMachineMaxVCPUs {
			return machine, factoryMachineInvalid{fmt.Sprintf("%s machine.vcpus must be between 1 and %d", factoryProjectionPath, factoryMachineMaxVCPUs)}
		}
		machine.VCPUs = int32(*declared.VCPUs)
	}
	if declared.MemoryMiB != nil {
		if *declared.MemoryMiB < 1 || *declared.MemoryMiB > factoryMachineMaxMemoryMiB {
			return machine, factoryMachineInvalid{fmt.Sprintf("%s machine.memoryMiB must be between 1 and %d", factoryProjectionPath, factoryMachineMaxMemoryMiB)}
		}
		machine.MemoryMiB = int32(*declared.MemoryMiB)
	}
	if len(declared.Tools) > factoryMachineMaxTools {
		return machine, factoryMachineInvalid{fmt.Sprintf("%s machine.tools names more than %d tools", factoryProjectionPath, factoryMachineMaxTools)}
	}
	seen := map[string]bool{}
	for _, tool := range declared.Tools {
		if !factoryMachineToolPattern.MatchString(tool) {
			return machine, factoryMachineInvalid{fmt.Sprintf("%s machine.tools entry %q is not a tool name", factoryProjectionPath, tool)}
		}
		if seen[tool] {
			return machine, factoryMachineInvalid{fmt.Sprintf("%s machine.tools names %q twice", factoryProjectionPath, tool)}
		}
		seen[tool] = true
		machine.Tools = append(machine.Tools, tool)
	}
	return machine, nil
}

// readRepositoryMachine is the machine the owner committed to the
// repository's default bookmark: the projection's machine block and whether
// that commit declares a NixOS environment. No bookmark declares nothing; a
// failed read is an error, so a lane is never placed on a guess.
func readRepositoryMachine(ctx context.Context, host repositoryPolicyHost, owner, repo, bookmark string) (MythicalMachine, error) {
	if host == nil {
		return MythicalMachine{}, errors.New("repository policy reader unavailable")
	}
	commit, found, err := bookmarkCommit(ctx, host, owner, repo, bookmark)
	if err != nil || !found {
		return MythicalMachine{}, err
	}
	projection, _, err := readCommittedText(ctx, host, owner, repo, commit, factoryProjectionPath)
	if err != nil {
		return MythicalMachine{}, err
	}
	machine, err := parseFactoryMachine([]byte(projection))
	if err != nil {
		return MythicalMachine{}, err
	}
	machine.Revision = commit
	if content, declared, err := readCommittedText(ctx, host, owner, repo, commit, defaultWorkspaceEnvironmentSource); err != nil {
		return MythicalMachine{}, err
	} else if declared {
		machine.Environment, machine.EnvironmentDigest = defaultWorkspaceEnvironmentSource, environmentDigest(content)
	}
	return machine, nil
}

// environmentDigest identifies one .smithers/environment.nix by content.
func environmentDigest(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// imageEnvironmentDigest is the digest of the .smithers/environment.nix an
// image was built from: the file at the commit its registrar recorded, or ""
// when that revision is no commit or carries no such file. It is the
// declaration's own digest when the image was built at the declared commit.
func imageEnvironmentDigest(ctx context.Context, host repositoryPolicyHost, owner, repo string, declared MythicalMachine, image runtimeports.SandboxEnvironmentImage) (string, error) {
	revision := strings.TrimSpace(image.SourceRevision)
	if revision == declared.Revision {
		return declared.EnvironmentDigest, nil
	}
	if !isImmutableGitObjectID(revision) {
		return "", nil
	}
	content, found, err := readCommittedText(ctx, host, owner, repo, revision, defaultWorkspaceEnvironmentSource)
	if err != nil || !found {
		return "", err
	}
	return environmentDigest(content), nil
}

// readCommittedText is one text file at a commit, and whether it exists.
func readCommittedText(ctx context.Context, host repositoryPolicyHost, owner, repo, commit, path string) (string, bool, error) {
	file, err := host.GetFileAtChange(ctx, owner, repo, commit, path)
	if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read %s: %w", path, err)
	}
	if file.TooLarge || file.Encoding == "base64" {
		return "", false, errors.New(path + " is not readable text")
	}
	return file.Content, true, nil
}

// mythicalMachineOffer is the machine this deployment boots a lane on.
type mythicalMachineOffer struct {
	VCPUs     int32
	MemoryMiB int32
	// NixOS is whether lanes here boot a registered NixOS image exactly.
	NixOS bool
	// Image is the repository's own ready NixOS image, or nil when none is
	// registered; the platform base image never stands in for a declared
	// environment. ImageDigest is the digest of the environment.nix it was
	// built from, "" when unknown.
	Image       *runtimeports.SandboxEnvironmentImage
	ImageDigest string
}

// MythicalPlacement is the placement receipt recorded on the item for its
// latest lane: what was declared, the machine chosen, or the typed refusal.
type MythicalPlacement struct {
	Declared MythicalMachine `json:"declared"`
	// Kind is the lane workspace's kind: vm boots the declared NixOS
	// environment, container the platform's default guest. Empty when refused.
	Kind          string `json:"kind,omitempty"`
	VCPUs         int32  `json:"vcpus,omitempty"`
	MemoryMiB     int32  `json:"memoryMiB,omitempty"`
	ImageID       string `json:"imageId,omitempty"`
	Image         string `json:"image,omitempty"`
	ClosureHash   string `json:"closureHash,omitempty"`
	ImageRevision string `json:"imageRevision,omitempty"`
	// Refusal is the typed reason no machine was chosen, and Reason its
	// sentence.
	Refusal string `json:"refusal,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// placeMythicalLane decides the machine for a declaration, or refuses.
func placeMythicalLane(declared MythicalMachine, offer mythicalMachineOffer) MythicalPlacement {
	placement := MythicalPlacement{Declared: declared}
	refuse := func(code, reason string) MythicalPlacement {
		placement.Refusal, placement.Reason = code, reason
		return placement
	}
	switch {
	case declared.Environment == "" && len(declared.Tools) > 0:
		return refuse(placementToolsWithoutEnvironment, "it needs "+strings.Join(declared.Tools, ", ")+
			" and the repository declares no "+defaultWorkspaceEnvironmentSource+" to provide them")
	case declared.Environment != "" && !offer.NixOS:
		return refuse(placementEnvironmentUnsupported, "lane machines here cannot boot a NixOS environment")
	case declared.Environment != "" && offer.Image == nil:
		return refuse(placementEnvironmentUnbuilt, "no machine is built from "+declared.Environment+" yet; register its NixOS image")
	case declared.Environment != "" && offer.ImageDigest != declared.EnvironmentDigest:
		return refuse(placementEnvironmentStale, "the registered NixOS image was built from another "+declared.Environment+
			"; register one built at "+shortRevision(declared.Revision))
	case declared.VCPUs > offer.VCPUs:
		return refuse(placementMachineTooSmall, fmt.Sprintf("it needs %d vCPUs and lane machines here have %d", declared.VCPUs, offer.VCPUs))
	case declared.MemoryMiB > offer.MemoryMiB:
		return refuse(placementMachineTooSmall, fmt.Sprintf("it needs %d MiB of memory and lane machines here have %d MiB", declared.MemoryMiB, offer.MemoryMiB))
	}
	placement.Kind, placement.VCPUs, placement.MemoryMiB = "container", offer.VCPUs, offer.MemoryMiB
	if declared.Environment != "" {
		placement.Kind = "vm"
		placement.ImageID, placement.Image, placement.ClosureHash, placement.ImageRevision =
			offer.Image.ID, offer.Image.Image, offer.Image.ClosureHash, offer.Image.SourceRevision
	}
	return placement
}

// shortRevision is a commit id as people read it.
func shortRevision(revision string) string {
	if len(revision) > 12 {
		return revision[:12]
	}
	return revision
}

// place chooses the machine for an item's next lane. It answers the item to
// save instead when there is none: a typed stop for a refusal the owner
// fixes, an infra outage when the declaration or the offer could not be read.
func (st *mythicalItemStep) place(ctx context.Context, item db.MythicalItem) (MythicalPlacement, *db.MythicalItem) {
	s, r := st.s, st.r
	repository, owner, err := s.repository(ctx, r.row.RepositoryID)
	if err != nil {
		return MythicalPlacement{}, mythicalInfraOutage(item, "launch", "the repository could not be read", st.now)
	}
	declared, err := readRepositoryMachine(ctx, s.policy, owner, repository.Name, repository.DefaultBookmark)
	var invalid factoryMachineInvalid
	switch {
	case errors.As(err, &invalid):
		return mythicalPlaced(item, MythicalPlacement{Refusal: placementMachineInvalid, Reason: invalid.reason})
	case err != nil:
		return MythicalPlacement{}, mythicalInfraOutage(item, "launch", "the repository's machine could not be read", st.now)
	}
	offer, err := s.lanes.Offer(ctx, r.row.RepositoryID)
	if err != nil {
		return MythicalPlacement{}, mythicalInfraOutage(item, "launch", "the lane machines could not be read", st.now)
	}
	if declared.Environment != "" && offer.Image != nil {
		if offer.ImageDigest, err = imageEnvironmentDigest(ctx, s.policy, owner, repository.Name, declared, *offer.Image); err != nil {
			return MythicalPlacement{}, mythicalInfraOutage(item, "launch", "the image's environment could not be read", st.now)
		}
	}
	placement := placeMythicalLane(declared, offer)
	if placement.Refusal != "" {
		return mythicalPlaced(item, placement)
	}
	return placement, nil
}

// mythicalPlaced stops an item at a refused placement, with the refusal
// recorded on its receipt.
func mythicalPlaced(item db.MythicalItem, placement MythicalPlacement) (MythicalPlacement, *db.MythicalItem) {
	stopped := mythicalStop(item, mythicalFault{Class: "policy", Tag: "placement", Kind: mythicalFailStopped}, "no machine matches this repository: "+placement.Reason)
	checks := mythicalChecksOf(*stopped)
	checks.Placement = &placement
	stopped.Checks = checks.encode()
	return placement, stopped
}

// Offer is the machine a lane boots on here: the workspace size, whether
// the workspace runtime (where every lane's run executes) boots NixOS images,
// and the repository's own ready NixOS image when it does and one is
// registered.
func (l *workspaceMythicalLanes) Offer(ctx context.Context, repositoryID int64) (mythicalMachineOffer, error) {
	if l == nil || l.workspaces == nil {
		return mythicalMachineOffer{}, pkgerrors.Internal("workspaces are unavailable")
	}
	memory, vcpus := l.workspaces.workspaceSizeForKind("vm")
	offer := mythicalMachineOffer{VCPUs: *vcpus, MemoryMiB: *memory}
	offer.NixOS = l.workspaces.runtime != nil && l.workspaces.runtime.Capabilities().EnvironmentImages
	if !offer.NixOS || l.workspaces.environmentImages == nil {
		return offer, nil
	}
	image, err := l.workspaces.environmentImages.Resolve(ctx, repositoryID, "vm")
	var api *pkgerrors.APIError
	if errors.As(err, &api) && api.Code == pkgerrors.CodeEnvironmentImageUnavailable {
		return offer, nil
	}
	if err != nil {
		return mythicalMachineOffer{}, err
	}
	if image.RepositoryID.Valid && image.RepositoryID.Int64 == repositoryID {
		offer.Image = &image
	}
	return offer, nil
}

// placedWorkspaceMetadata is the workspace a placement boots.
func placedWorkspaceMetadata(placement MythicalPlacement) workspaceCreateMetadata {
	return workspaceCreateMetadata{kind: placement.Kind, environment: WorkspaceEnvironment{
		Source: defaultWorkspaceEnvironmentSource, Revision: placement.ImageRevision, ClosureHash: placement.ClosureHash,
	}}
}

// Placed reports whether a lane workspace runs on the placement's machine:
// the same kind and, for a NixOS lane, the same closure it was created or
// booted with. A workspace that is gone runs on no machine.
func (l *workspaceMythicalLanes) Placed(ctx context.Context, workspaceID string, placement MythicalPlacement) (bool, error) {
	if l == nil || l.workspaces == nil || l.workspaces.q == nil {
		return false, pkgerrors.Internal("workspaces are unavailable")
	}
	workspace, err := l.workspaces.q.GetWorkspace(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	kind := normalizeWorkspaceKind(placement.Kind)
	return !workspace.DeletedAt.Valid && normalizeWorkspaceKind(workspace.Kind) == kind &&
		(kind != "vm" || workspace.EnvironmentClosureHash == placement.ClosureHash), nil
}

// LaneTools is what a stack lane's box must have on PATH before its run
// starts: the tools its item's placement declares. A workspace that is no
// live lane, or whose item was not placed on a machine, needs none.
func (s *MythicalService) LaneTools(ctx context.Context, workspaceID string) ([]string, error) {
	q := s.queries()
	lane, err := q.GetMythicalLane(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lane.RetiredAt.Valid {
		return nil, nil
	}
	item, err := q.GetMythicalItem(ctx, lane.ItemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	placement := mythicalChecksOf(item).Placement
	if placement == nil || placement.Kind == "" {
		return nil, nil
	}
	return placement.Declared.Tools, nil
}
