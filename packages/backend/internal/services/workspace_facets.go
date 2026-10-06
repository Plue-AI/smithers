package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const (
	// MaxWorkspaceFileBytes bounds both file reads and writes. It is intentionally
	// aligned with the API's normal request-body limit so a workspace file cannot
	// be used to make either the API or the guest exec transport buffer without
	// bound.
	MaxWorkspaceFileBytes   = 1 << 20
	MaxWorkspaceFileChanges = 256

	workspaceFacetExecTimeoutMS = int64(30_000)
	workspaceServiceUnitDir     = "/etc/systemd/system"
	workspaceInternalUnitPrefix = "smithers-workspace-"
	workspacePreviewDomain      = "preview.jjhub.tech"
)

const (
	workspaceExecNotFound       int32 = 44
	workspaceExecOutsideRoot    int32 = 45
	workspaceExecWrongFileType  int32 = 46
	workspaceExecFileTooLarge   int32 = 47
	workspaceExecServiceFailure int32 = 50
)

var workspaceFileBaseDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var workspaceServiceNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.@:-]+$`)

// WorkspaceFileEntry is one immediate child in a workspace directory.
type WorkspaceFileEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
}

// WorkspaceFileContent is file data read from or written to a workspace.
// Text is returned as UTF-8. Binary data is returned as base64 so the JSON
// response never silently replaces invalid bytes.
type WorkspaceFileContent struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Type     string `json:"type"`
	Encoding string `json:"encoding"`
	Content  string `json:"content"`
	Size     int64  `json:"size"`
	Digest   string `json:"digest"`
}

// WorkspaceManagedService is an init-declared guest service and its current
// normalized state. State is one of running, stopped, or failed. Port and URL
// are present when the service has a listening TCP port; URL is the public
// preview-gateway address that relays to that workspace port.
type WorkspaceManagedService struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Port  int    `json:"port,omitempty"`
	URL   string `json:"url,omitempty"`
}

type workspaceFacetExecClient interface {
	Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
}

type workspaceFacetIngressClient interface {
	PublishIngress(ctx context.Context, domain string, req sandbox.PublishIngressRequest) (sandbox.IngressRoute, error)
}

// ListWorkspaceFiles lists the immediate children of path inside the working
// copy. Read access is sufficient; symlinks cannot be used to leave the copy.
func (s *WorkspaceService) ListWorkspaceFiles(ctx context.Context, workspaceID string, repositoryID, userID int64, filePath string) ([]WorkspaceFileEntry, error) {
	relativePath, absolutePath, err := workspaceFilePath(filePath, true)
	if err != nil {
		return nil, err
	}
	if row, owner, repo, head, asleep, err := s.workspaceSnapshotTarget(ctx, workspaceID, repositoryID, userID); err != nil {
		return nil, err
	} else if asleep {
		return s.listWorkspaceSnapshot(ctx, row, owner, repo, head, relativePath)
	}
	if s.runtime != nil {
		row, runtimeCtx, targetErr := s.workspaceRuntimeFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead, "")
		if targetErr != nil {
			return nil, targetErr
		}
		listed, listErr := s.runtime.ListFiles(runtimeCtx, row.ID, relativePath)
		if listErr != nil {
			return nil, mapRuntimeFileError(listErr, "directory")
		}
		entries := make([]WorkspaceFileEntry, 0, len(listed))
		for _, entry := range listed {
			entryType := "file"
			size := entry.Size
			switch {
			case entry.Mode&fs.ModeSymlink != 0:
				entryType = "symlink"
			case entry.IsDir:
				entryType = "dir"
				size = 0
			}
			entryPath := entry.Name
			if relativePath != "" {
				entryPath = relativePath + "/" + entry.Name
			}
			entries = append(entries, WorkspaceFileEntry{Name: entry.Name, Path: entryPath, Type: entryType, Size: size})
		}
		sort.Slice(entries, func(i, j int) bool {
			if (entries[i].Type == "dir") != (entries[j].Type == "dir") {
				return entries[i].Type == "dir"
			}
			return entries[i].Name < entries[j].Name
		})
		s.touchWorkspaceEntryRecency(ctx, row.ID, "files")
		return entries, nil
	}
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return nil, err
	}

	command := workspacePathGuardCommand(absolutePath, true) + `
find "$resolved" -mindepth 1 -maxdepth 1 -printf '%f\0%y\0%s\0'`
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: workspaceFacetTimeoutPtr()})
	if err != nil {
		return nil, pkgerrors.Internal("list workspace files").WithCause(err)
	}
	if err := mapWorkspaceFileExecError(response, "directory"); err != nil {
		return nil, err
	}

	fields := strings.Split(response.Stdout, "\x00")
	if len(fields) > 0 && fields[len(fields)-1] == "" {
		fields = fields[:len(fields)-1]
	}
	if len(fields)%3 != 0 {
		return nil, pkgerrors.Internal("invalid workspace file listing")
	}
	entries := make([]WorkspaceFileEntry, 0, len(fields)/3)
	for index := 0; index < len(fields); index += 3 {
		name := fields[index]
		if name == "" || strings.Contains(name, "/") || strings.IndexByte(name, 0) >= 0 {
			return nil, pkgerrors.Internal("invalid workspace file listing")
		}
		size, parseErr := strconv.ParseInt(fields[index+2], 10, 64)
		if parseErr != nil || size < 0 {
			return nil, pkgerrors.Internal("invalid workspace file listing")
		}
		entryType := "file"
		switch fields[index+1] {
		case "d":
			entryType = "dir"
			size = 0
		case "l":
			entryType = "symlink"
		}
		entryPath := name
		if relativePath != "" {
			entryPath = relativePath + "/" + name
		}
		entries = append(entries, WorkspaceFileEntry{Name: name, Path: entryPath, Type: entryType, Size: size})
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Type == "dir") != (entries[j].Type == "dir") {
			return entries[i].Type == "dir"
		}
		return entries[i].Name < entries[j].Name
	})
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "files")
	return entries, nil
}

// ReadWorkspaceFile reads one bounded file inside the working copy.
func (s *WorkspaceService) ReadWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, filePath string) (WorkspaceFileContent, error) {
	relativePath, absolutePath, err := workspaceFilePath(filePath, false)
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	if _, owner, repo, head, asleep, err := s.workspaceSnapshotTarget(ctx, workspaceID, repositoryID, userID); err != nil {
		return WorkspaceFileContent{}, err
	} else if asleep {
		return s.readWorkspaceSnapshot(ctx, owner, repo, head, relativePath)
	}
	if s.runtime != nil {
		row, runtimeCtx, targetErr := s.workspaceRuntimeFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead, "")
		if targetErr != nil {
			return WorkspaceFileContent{}, targetErr
		}
		content, readErr := s.runtime.ReadFile(runtimeCtx, row.ID, relativePath)
		if readErr != nil {
			return WorkspaceFileContent{}, mapRuntimeFileError(readErr, "file")
		}
		if len(content) > MaxWorkspaceFileBytes {
			return WorkspaceFileContent{}, pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
		}
		result := workspaceFileContent(relativePath, content)
		s.touchWorkspaceEntryRecency(ctx, row.ID, "file-content")
		return result, nil
	}
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return WorkspaceFileContent{}, err
	}

	command := workspacePathGuardCommand(absolutePath, false) + fmt.Sprintf(`
size=$(stat -c %%s -- "$resolved") || exit %d
[ "$size" -le %d ] || exit %d
printf '%%s\0' "$size"
base64 -w0 -- "$resolved"`, workspaceExecNotFound, MaxWorkspaceFileBytes, workspaceExecFileTooLarge)
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: workspaceFacetTimeoutPtr()})
	if err != nil {
		return WorkspaceFileContent{}, pkgerrors.Internal("read workspace file").WithCause(err)
	}
	if err := mapWorkspaceFileExecError(response, "file"); err != nil {
		return WorkspaceFileContent{}, err
	}

	sizeField, encoded, ok := strings.Cut(response.Stdout, "\x00")
	if !ok {
		return WorkspaceFileContent{}, pkgerrors.Internal("invalid workspace file response")
	}
	size, parseErr := strconv.ParseInt(sizeField, 10, 64)
	if parseErr != nil || size < 0 || size > MaxWorkspaceFileBytes {
		return WorkspaceFileContent{}, pkgerrors.Internal("invalid workspace file response")
	}
	content, decodeErr := base64.StdEncoding.DecodeString(encoded)
	if decodeErr != nil || int64(len(content)) != size {
		return WorkspaceFileContent{}, pkgerrors.Internal("invalid workspace file response")
	}
	result := workspaceFileContent(relativePath, content)
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "file-content")
	return result, nil
}

// WorkspaceFileMutationResult acknowledges one path in a committed batch.
// Digest is "absent" for a removal, otherwise the full SHA-256 of the new bytes.
type WorkspaceFileMutationResult struct {
	Path   string `json:"path"`
	Digest string `json:"digest"`
}

// WriteWorkspaceFile uses the same transaction as a multi-file patch.
func (s *WorkspaceService) WriteWorkspaceFile(ctx context.Context, workspaceID string, repositoryID, userID int64, filePath, content, baseDigest string) (WorkspaceFileContent, error) {
	_, err := s.WriteWorkspaceFiles(ctx, workspaceID, repositoryID, userID, []workspaceapi.FileMutation{{Path: filePath, BaseDigest: baseDigest, Content: []byte(content)}})
	if err != nil {
		return WorkspaceFileContent{}, err
	}
	return workspaceFileContent(filePath, []byte(content)), nil
}

// WriteWorkspaceFiles authorizes once and submits the complete patch to a
// qualified provider. No per-file dispatch or unconditional fallback is safe.
func (s *WorkspaceService) WriteWorkspaceFiles(ctx context.Context, workspaceID string, repositoryID, userID int64, changes []workspaceapi.FileMutation) ([]WorkspaceFileMutationResult, error) {
	if len(changes) == 0 || len(changes) > MaxWorkspaceFileChanges {
		return nil, pkgerrors.BadRequest("changes must contain 1 to 256 files")
	}
	// Own the validated input across authorization and asynchronous runtime work.
	batch := make([]workspaceapi.FileMutation, len(changes))
	paths := make(map[string]bool, len(changes))
	total := 0
	results := make([]WorkspaceFileMutationResult, len(changes))
	for i, change := range changes {
		if change.BaseDigest != "absent" && !workspaceFileBaseDigestPattern.MatchString(change.BaseDigest) {
			return nil, pkgerrors.BadRequest("base_digest must be a SHA-256 digest or absent")
		}
		relativePath, _, err := workspaceFilePath(change.Path, false)
		if err != nil {
			return nil, err
		}
		if paths[relativePath] {
			return nil, pkgerrors.BadRequest("changes contain duplicate paths")
		}
		paths[relativePath] = true
		total += len(change.Content)
		if total > MaxWorkspaceFileBytes {
			return nil, pkgerrors.RequestEntityTooLarge("workspace file changes exceed 1 MiB limit")
		}
		batch[i] = workspaceapi.FileMutation{Path: relativePath, BaseDigest: change.BaseDigest, Content: bytes.Clone(change.Content)}
		digest := "absent"
		if change.Content != nil {
			digest = sha256Hex(string(change.Content))
		}
		results[i] = WorkspaceFileMutationResult{Path: relativePath, Digest: digest}
	}
	for name := range paths {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if paths[parent] {
				return nil, pkgerrors.BadRequest("changes contain overlapping paths")
			}
		}
	}
	// Structured encoding separates paths, bases, deletions and empty files;
	// delimiters alone could alias different auto-resume operation identities.
	encoded, err := json.Marshal(batch)
	if err != nil {
		return nil, pkgerrors.Internal("cannot encode workspace file changes")
	}
	err = s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		writer, ok := s.runtime.(workspaceapi.WorkspaceCompareWriter)
		if !ok {
			return pkgerrors.New(pkgerrors.CodeServiceUnavailable, "workspace compare-and-write unavailable")
		}
		row, runtimeCtx, targetErr := s.workspaceRuntimeFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite, "workspace-files:"+sha256Hex(string(encoded)))
		if targetErr != nil {
			return targetErr
		}
		if writeErr := writer.CompareWriteFiles(runtimeCtx, row.ID, batch); writeErr != nil {
			var stale *workspaceapi.StaleFileError
			if errors.As(writeErr, &stale) {
				if !paths[stale.Path] || (stale.CurrentDigest != "absent" && !workspaceFileBaseDigestPattern.MatchString(stale.CurrentDigest)) {
					return pkgerrors.Internal("invalid workspace stale file response")
				}
				return stale
			}
			return mapRuntimeFileError(writeErr, "file")
		}
		s.touchWorkspaceEntryRecency(ctx, row.ID, "file-content-write")
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// ListWorkspaceServices returns services declared as persistent units by the
// guest init path. Distribution-owned units are excluded: init-managed
// declarations are regular unit files in /etc/systemd/system, while package
// units live below /usr and aliases in this directory are symlinks.
func (s *WorkspaceService) ListWorkspaceServices(ctx context.Context, workspaceID string, repositoryID, userID int64) ([]WorkspaceManagedService, error) {
	if s.runtime != nil {
		row, _, err := s.workspaceRuntimeFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead, "")
		if err != nil {
			return nil, err
		}
		services, err := s.listRuntimeWorkspaceServices(ctx, row, userID)
		if err == nil {
			s.touchWorkspaceEntryRecency(ctx, row.ID, "services")
		}
		return services, err
	}
	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessRead)
	if err != nil {
		return nil, err
	}

	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: workspaceServiceListCommand(), TimeoutMS: workspaceFacetTimeoutPtr()})
	if err != nil {
		return nil, pkgerrors.Internal("list workspace services").WithCause(err)
	}
	if !workspaceExecSucceeded(response) {
		return nil, pkgerrors.Internal("list workspace services")
	}
	services, err := parseWorkspaceServices(response.Stdout)
	if err != nil {
		return nil, err
	}
	// Publishing preview ingress is a mutation: a reader lists services
	// without routes (#3212).
	writable, err := s.workspaceWritable(ctx, workspace, userID)
	if err != nil {
		return nil, err
	}
	if writable {
		if err := s.withWorkspaceMutationAuthority(ctx, workspace, userID, func(ctx context.Context) error {
			return s.publishWorkspaceServicePreviews(ctx, workspace, services)
		}); err != nil {
			return nil, err
		}
	}
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "services")
	return services, nil
}

// ManageWorkspaceService starts, stops, or restarts one init-declared service.
func (s *WorkspaceService) ManageWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, serviceName, action string) (WorkspaceManagedService, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	switch action {
	case "start", "stop", "restart":
	default:
		return WorkspaceManagedService{}, pkgerrors.BadRequest("service action must be start, stop, or restart")
	}
	name := strings.TrimSpace(serviceName)
	name = strings.TrimSuffix(name, ".service")
	if name == "" || len(name) > 255 || !workspaceServiceNamePattern.MatchString(name) {
		return WorkspaceManagedService{}, pkgerrors.BadRequest("invalid workspace service name")
	}
	if strings.HasPrefix(name, workspaceInternalUnitPrefix) {
		return WorkspaceManagedService{}, pkgerrors.NotFound("workspace service not found")
	}
	var managed WorkspaceManagedService
	err := s.withWorkspaceMutation(ctx, workspaceID, repositoryID, userID, func(ctx context.Context, _ db.Workspace) error {
		var err error
		managed, err = s.manageWorkspaceService(ctx, workspaceID, repositoryID, userID, name, action)
		return err
	})
	return managed, err
}

func (s *WorkspaceService) manageWorkspaceService(ctx context.Context, workspaceID string, repositoryID, userID int64, name, action string) (WorkspaceManagedService, error) {
	if s.runtime != nil {
		controller, ok := s.runtime.(workspaceapi.WorkspaceNamedServiceController)
		if !ok {
			return WorkspaceManagedService{}, pkgerrors.Internal("workspace service management unavailable")
		}
		row, runtimeCtx, err := s.workspaceRuntimeFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite, "workspace-service:"+workspaceID+":"+name+":"+action)
		if err != nil {
			return WorkspaceManagedService{}, err
		}
		observed, err := controller.ManageService(runtimeCtx, row.ID, name, action)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return WorkspaceManagedService{}, pkgerrors.NotFound("workspace service not found")
			}
			return WorkspaceManagedService{}, pkgerrors.Internal(action + " workspace service")
		}
		s.touchWorkspaceEntryRecency(ctx, row.ID, "service-"+action)
		managed := runtimeManagedService(observed.Name, observed.State, observed.Address, observed.ExitCode)
		if action == "stop" {
			managed.State = "stopped"
		}
		return managed, nil
	}

	workspace, client, err := s.workspaceFacetTarget(ctx, workspaceID, repositoryID, userID, WorkspaceAccessWrite)
	if err != nil {
		return WorkspaceManagedService{}, err
	}
	unit := name + ".service"
	unitPath := path.Join(workspaceServiceUnitDir, unit)
	command := fmt.Sprintf(`%s
unit=%s
unit_path=%s
[ -f "$unit_path" ] && [ ! -L "$unit_path" ] || exit %d
systemctl %s -- "$unit" >/dev/null 2>&1 || exit %d
load=$(systemctl show --property=LoadState --value -- "$unit")
active=$(systemctl show --property=ActiveState --value -- "$unit")
sub=$(systemctl show --property=SubState --value -- "$unit")
port=$(workspace_service_port "$unit")
printf '%%s\0%%s\0%%s\0%%s\0%%s\0' "$unit" "$load" "$active" "$sub" "$port"`, workspaceServicePortProbeCommand(), shellQuote(unit), shellQuote(unitPath), workspaceExecNotFound, action, workspaceExecServiceFailure)
	response, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{Command: command, TimeoutMS: workspaceFacetTimeoutPtr()})
	if err != nil {
		return WorkspaceManagedService{}, pkgerrors.Internal(action + " workspace service")
	}
	if code := workspaceExecCode(response); code != 0 {
		if code == workspaceExecNotFound {
			return WorkspaceManagedService{}, pkgerrors.NotFound("workspace service not found")
		}
		return WorkspaceManagedService{}, pkgerrors.Internal(action + " workspace service")
	}
	services, err := parseWorkspaceServices(response.Stdout)
	if err != nil || len(services) != 1 || services[0].Name != name {
		return WorkspaceManagedService{}, pkgerrors.Internal("invalid workspace service response")
	}
	if err := s.publishWorkspaceServicePreviews(ctx, workspace, services); err != nil {
		return WorkspaceManagedService{}, err
	}
	s.touchWorkspaceEntryRecency(ctx, workspace.ID, "service-"+action)
	return services[0], nil
}

// workspaceRuntimeFacetTarget resolves the workspace a facet runs against. A
// write action starts it when stopped; reads never start it.
// Write-level callers hold the mutation
// authority (withWorkspaceMutation) around this call and their mutation.
func (s *WorkspaceService) workspaceRuntimeFacetTarget(ctx context.Context, workspaceID string, repositoryID, userID int64, access WorkspaceAccessLevel, operationID string) (db.Workspace, context.Context, error) {
	if s == nil || s.q == nil {
		return db.Workspace{}, nil, pkgerrors.Internal("workspace store unavailable")
	}
	row, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, access)
	if err != nil {
		return db.Workspace{}, nil, err
	}
	if access == WorkspaceAccessRead && (row.Status == "suspended" || row.Status == "stopped") {
		return db.Workspace{}, nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "snapshot reads require an authoritative branch runtime binding")
	}
	if access == WorkspaceAccessWrite {
		row, err = s.ensureRuntimeWorkspaceRunning(ctx, row, userID)
	} else {
		row, err = s.runningRuntimeWorkspace(ctx, row, userID)
	}
	if err != nil {
		return db.Workspace{}, nil, err
	}
	runtimeCtx, err := s.workspaceRuntimeContext(ctx, row, userID, operationID)
	if err != nil {
		return db.Workspace{}, nil, err
	}
	return row, runtimeCtx, nil
}

// workspaceFacetTarget is workspaceRuntimeFacetTarget for the sandbox
// provider: a reader never resumes the VM.
func (s *WorkspaceService) workspaceFacetTarget(ctx context.Context, workspaceID string, repositoryID, userID int64, access WorkspaceAccessLevel) (db.Workspace, workspaceFacetExecClient, error) {
	if s == nil || s.q == nil {
		return db.Workspace{}, nil, pkgerrors.Internal("workspace store unavailable")
	}
	workspace, err := s.loadWorkspaceWithAccess(ctx, workspaceID, repositoryID, userID, access)
	if err != nil {
		return db.Workspace{}, nil, err
	}
	if access == WorkspaceAccessRead && (workspace.Status == "suspended" || workspace.Status == "stopped") {
		return db.Workspace{}, nil, pkgerrors.New(pkgerrors.CodeServiceUnavailable, "snapshot reads require an authoritative branch runtime binding")
	}
	if access == WorkspaceAccessWrite {
		workspace, err = s.ensureExistingWorkspaceRunningFor(ctx, workspace, userID)
	} else {
		workspace, err = s.runningSandboxWorkspace(ctx, workspace, userID)
	}
	if err != nil {
		return db.Workspace{}, nil, err
	}
	client, ok := s.sandbox.(workspaceFacetExecClient)
	if !ok {
		return db.Workspace{}, nil, pkgerrors.Internal("workspace execution unavailable")
	}
	return workspace, client, nil
}

// runningSandboxWorkspace serves a reader on the sandbox provider: the VM must
// already run.
func (s *WorkspaceService) runningSandboxWorkspace(ctx context.Context, workspace db.Workspace, requesterID int64) (db.Workspace, error) {
	if s.runtime != nil {
		return s.runningRuntimeWorkspace(ctx, workspace, requesterID)
	}
	if workspace.Status != "running" || strings.TrimSpace(workspace.VmID) == "" || s.sandbox == nil {
		return workspace, errWorkspaceStopped()
	}
	vm, err := s.sandbox.InspectSandbox(ctx, workspace.VmID)
	if err != nil {
		if vmAlreadyGone(err) {
			return workspace, errWorkspaceStopped()
		}
		return workspace, workspaceProvisioningError("get sandbox", err)
	}
	if vm.State != sandbox.StateRunning {
		return workspace, errWorkspaceStopped()
	}
	return workspace, nil
}

func workspaceFilePath(raw string, allowRoot bool) (string, string, error) {
	if len(raw) > 4096 || strings.IndexByte(raw, 0) >= 0 || strings.HasPrefix(raw, "/") {
		return "", "", pkgerrors.BadRequest("invalid workspace file path")
	}
	if raw == "" {
		if allowRoot {
			return "", defaultWorkspaceClonePath, nil
		}
		return "", "", pkgerrors.BadRequest("path is required")
	}
	segments := strings.Split(raw, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", "", pkgerrors.BadRequest("invalid workspace file path")
		}
	}
	cleaned := path.Clean(raw)
	if cleaned == "." {
		if allowRoot {
			return "", defaultWorkspaceClonePath, nil
		}
		return "", "", pkgerrors.BadRequest("path is required")
	}
	return cleaned, path.Join(defaultWorkspaceClonePath, cleaned), nil
}

func workspacePathGuardCommand(absolutePath string, directory bool) string {
	typeFlag := "-f"
	wrongType := "file"
	if directory {
		typeFlag = "-d"
		wrongType = "directory"
	}
	return fmt.Sprintf(`root=%s
target=%s
resolved=$(realpath -e -- "$target") || exit %d
case "$resolved" in "$root"|"$root"/*) ;; *) exit %d ;; esac
[ %s "$resolved" ] || { printf 'not a %s' >&2; exit %d; }`, shellQuote(defaultWorkspaceClonePath), shellQuote(absolutePath), workspaceExecNotFound, workspaceExecOutsideRoot, typeFlag, wrongType, workspaceExecWrongFileType)
}

func workspaceFileContent(relativePath string, content []byte) WorkspaceFileContent {
	result := WorkspaceFileContent{
		Name:     path.Base(relativePath),
		Path:     relativePath,
		Type:     "file",
		Encoding: "utf-8",
		Content:  string(content),
		Size:     int64(len(content)),
		Digest:   sha256Hex(string(content)),
	}
	if !utf8.Valid(content) {
		result.Encoding = "base64"
		result.Content = base64.StdEncoding.EncodeToString(content)
	}
	return result
}

func workspaceFacetTimeoutPtr() *int64 {
	timeout := workspaceFacetExecTimeoutMS
	return &timeout
}

func workspaceExecCode(response sandbox.ExecResult) int32 {
	if response.StatusCode == nil {
		return -1
	}
	return *response.StatusCode
}

func workspaceExecSucceeded(response sandbox.ExecResult) bool {
	return workspaceExecCode(response) == 0
}

func mapWorkspaceFileExecError(response sandbox.ExecResult, kind string) error {
	switch workspaceExecCode(response) {
	case 0:
		return nil
	case workspaceExecNotFound:
		return pkgerrors.NotFound("workspace " + kind + " not found")
	case workspaceExecOutsideRoot:
		return pkgerrors.BadRequest("workspace path resolves outside the working copy")
	case workspaceExecWrongFileType:
		return pkgerrors.BadRequest("workspace path is not a " + kind)
	case workspaceExecFileTooLarge:
		return pkgerrors.RequestEntityTooLarge("workspace file exceeds 1 MiB limit")
	default:
		return pkgerrors.Internal("workspace file operation failed")
	}
}

func workspaceServiceListCommand() string {
	return fmt.Sprintf(`%s
for unit_path in %s/*.service; do
  [ -f "$unit_path" ] && [ ! -L "$unit_path" ] || continue
  unit=${unit_path##*/}
  case "$unit" in %s*) continue ;; esac
  load=$(systemctl show --property=LoadState --value -- "$unit")
  active=$(systemctl show --property=ActiveState --value -- "$unit")
  sub=$(systemctl show --property=SubState --value -- "$unit")
  port=$(workspace_service_port "$unit")
  printf '%%s\0%%s\0%%s\0%%s\0%%s\0' "$unit" "$load" "$active" "$sub" "$port"
done`, workspaceServicePortProbeCommand(), shellQuote(workspaceServiceUnitDir), workspaceInternalUnitPrefix)
}

// workspaceServicePortProbeCommand emits a shell helper that finds the first
// TCP listener owned by any process in a service's systemd cgroup. Looking at
// the whole cgroup, rather than MainPID alone, covers the common shell -> npm ->
// dev-server process tree while excluding listeners owned by other units.
func workspaceServicePortProbeCommand() string {
	return `workspace_service_port() {
  control_group=$(systemctl show --property=ControlGroup --value -- "$1")
  case "$control_group" in
    /system.slice/*)
      cgroup_procs="/sys/fs/cgroup${control_group}/cgroup.procs"
      [ -r "$cgroup_procs" ] || return 0
      pid_list=" $(tr '\n' ' ' < "$cgroup_procs") "
      ss -H -ltnp 2>/dev/null | awk -v pids="$pid_list" '
        {
          owners = $0
          while (match(owners, /pid=[0-9]+,/)) {
            pid = substr(owners, RSTART + 4, RLENGTH - 5)
            if (index(pids, " " pid " ") != 0) {
              address = $4
              sub(/^.*:/, "", address)
              if (address ~ /^[0-9]+$/ && address >= 1 && address <= 65535) {
                print address
                exit
              }
            }
            owners = substr(owners, RSTART + RLENGTH)
          }
        }'
      ;;
  esac
}`
}

func parseWorkspaceServices(output string) ([]WorkspaceManagedService, error) {
	fields := strings.Split(output, "\x00")
	if len(fields) > 0 && fields[len(fields)-1] == "" {
		fields = fields[:len(fields)-1]
	}
	if len(fields)%5 != 0 {
		return nil, pkgerrors.Internal("invalid workspace service response")
	}
	services := make([]WorkspaceManagedService, 0, len(fields)/5)
	for index := 0; index < len(fields); index += 5 {
		unit := fields[index]
		if !strings.HasSuffix(unit, ".service") {
			return nil, pkgerrors.Internal("invalid workspace service response")
		}
		name := strings.TrimSuffix(unit, ".service")
		if name == "" || !workspaceServiceNamePattern.MatchString(name) {
			return nil, pkgerrors.Internal("invalid workspace service response")
		}
		port := 0
		if rawPort := strings.TrimSpace(fields[index+4]); rawPort != "" {
			parsedPort, parseErr := strconv.Atoi(rawPort)
			if parseErr != nil || parsedPort < 1 || parsedPort > 65535 {
				return nil, pkgerrors.Internal("invalid workspace service response")
			}
			port = parsedPort
		}
		services = append(services, WorkspaceManagedService{Name: name, State: normalizeWorkspaceServiceState(fields[index+1], fields[index+2], fields[index+3]), Port: port})
	}
	sort.Slice(services, func(i, j int) bool { return services[i].Name < services[j].Name })
	return services, nil
}

func (s *WorkspaceService) publishWorkspaceServicePreviews(ctx context.Context, workspace db.Workspace, services []WorkspaceManagedService) error {
	ports := make(map[int]string)
	for _, service := range services {
		if service.Port > 0 {
			ports[service.Port] = workspaceServicePreviewDomain(workspace.ID, service.Port)
		}
	}
	if len(ports) == 0 {
		return nil
	}
	ingress, ok := s.sandbox.(workspaceFacetIngressClient)
	if !ok {
		return pkgerrors.Internal("workspace service previews unavailable")
	}
	orderedPorts := make([]int, 0, len(ports))
	for port := range ports {
		orderedPorts = append(orderedPorts, port)
	}
	sort.Ints(orderedPorts)
	for _, port := range orderedPorts {
		domain := ports[port]
		if _, err := ingress.PublishIngress(ctx, domain, sandbox.PublishIngressRequest{SandboxID: workspace.VmID, Port: int32(port)}); err != nil {
			// preview_unavailable has been in the registry, unused, since it
			// was added: the preview gateway not taking the publish is plue's
			// ingress failing, not a defect in the caller's box.
			return pkgerrors.New(pkgerrors.CodePreviewUnavailable, "publish workspace service preview")
		}
	}
	for index := range services {
		if domain := ports[services[index].Port]; domain != "" {
			services[index].URL = "https://" + domain
		}
	}
	return nil
}

func workspaceServicePreviewDomain(workspaceID string, port int) string {
	return fmt.Sprintf("%d-%s.%s", port, strings.ToLower(strings.TrimSpace(workspaceID)), workspacePreviewDomain)
}

func normalizeWorkspaceServiceState(load, active, sub string) string {
	if load == "failed" || active == "failed" || sub == "failed" {
		return "failed"
	}
	switch active {
	case "active", "activating", "reloading":
		return "running"
	default:
		return "stopped"
	}
}
