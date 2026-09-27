package flowhost

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"path"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/modelproxy"
)

// BuildProcessSpec materializes the one reviewed host command after the
// deployment adapter allocates a port in its own network namespace. Both
// trusted-process and Plue launch this spec; only their transport differs.
func BuildProcessSpec(launch HostLaunch, paths WorkspacePaths, port uint16) (ProcessSpec, error) {
	if err := bindingMatches(launch.Binding, launch.Authority, launch.Catalog); err != nil {
		return ProcessSpec{}, err
	}
	if strings.TrimSpace(launch.Credential) == "" || port == 0 {
		return ProcessSpec{}, errors.New("flow host process needs a credential and allocated port")
	}
	root := strings.TrimSpace(paths.Root)
	stateBase := strings.TrimSpace(paths.StateDir)
	if root == "" || stateBase == "" || !path.IsAbs(root) || !path.IsAbs(stateBase) {
		return ProcessSpec{}, errors.New("flow host workspace root and state directory must be absolute runtime paths")
	}
	// The managed-host adapter already supplied a binding-specific state path.
	stateDir := stateBase
	host := paths.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if net.ParseIP(host) == nil {
		return ProcessSpec{}, errors.New("flow host bind address must be an adapter-selected IP")
	}
	environment := make(map[string]string, len(launch.Catalog.Environment)+8)
	for name, value := range launch.Catalog.Environment {
		environment[name] = value
	}
	if launch.Catalog.ModelProxyURL != "" && len(launch.Catalog.ModelSeats) > 0 {
		for name, value := range modelproxy.GuestEnvironment(launch.Catalog.ModelProxyURL, launch.Catalog.ModelSeats) {
			environment[name] = value
		}
		credential := ModelCredential(launch.Binding.ID, launch.Credential)
		for _, seat := range launch.Catalog.ModelSeats {
			environment[seat.KeyEnv] = credential
		}
	}
	if launch.Catalog.AccountPoolURL != "" {
		environment[AccountPoolURLEnv] = launch.Catalog.AccountPoolURL
		environment[AccountPoolProvidersEnv] = AccountPoolRoutes
		environment[AccountPoolKeyEnv] = ModelCredential(launch.Binding.ID, launch.Credential)
	}
	environment["SMITHERS_API_KEY"] = launch.Credential
	environment["SMITHERS_GATEWAY_ID"] = launch.Binding.ID
	environment["SMITHERS_OWNER_GENERATION"] = strconv.FormatInt(launch.Binding.OwnerGeneration, 10)
	environment["SMITHERS_FLOW_ARTIFACT_SHA256"] = launch.Binding.RuntimeArtifactDigest
	environment["SMITHERS_SOURCE_REVISION"] = launch.Binding.SourceRevision
	switch launch.Catalog.Family {
	case CatalogCoding:
		if launch.Catalog.ImplementationModel != "" {
			environment["SMITHERS_CODING_IMPLEMENT_MODEL"] = launch.Catalog.ImplementationModel
		}
	case CatalogLibrarian:
		if strings.TrimSpace(launch.Authority.Repository) == "" {
			return ProcessSpec{}, errors.New("librarian host needs its authorized repository name")
		}
		environment["SMITHERS_REPO"] = launch.Authority.Repository
		environment["SMITHERS_PRODUCT_API_URL"] = launch.Catalog.ProductAPIURL
		if launch.Catalog.ImplementationModel != "" {
			environment["SMITHERS_LIBRARIAN_MODEL"] = launch.Catalog.ImplementationModel
		}
	default:
		return ProcessSpec{}, errors.New("flow host family is unsupported")
	}
	args := []string{launch.Catalog.Executable, "serve", "--root", root, "--state-dir", stateDir,
		"--host", host, "--port", strconv.Itoa(int(port)), "--listen"}
	return ProcessSpec{
		Name: launch.Binding.ServiceName, Identity: hostServiceIdentity(launch),
		Args: args, Environment: environment, ReadyAddress: net.JoinHostPort(host, strconv.Itoa(int(port))),
		ReadyTimeout: launch.Catalog.ReadyTimeout,
	}, nil
}

// Port and adapter paths are observations, not immutable host authority.
// Include the entire operator configuration so changed model/env settings
// cannot silently reuse a live process with an older command.
func hostServiceIdentity(launch HostLaunch) string {
	identity := struct {
		BindingID, WorkspaceID, Artifact, Revision string
		Generation                                 int64
		Catalog                                    Catalog
		Repository                                 string
	}{launch.Binding.ID, launch.Binding.WorkspaceID, launch.Binding.RuntimeArtifactDigest, launch.Binding.SourceRevision, launch.Binding.OwnerGeneration, launch.Catalog, launch.Authority.Repository}
	data, _ := json.Marshal(identity)
	digest := sha256.Sum256(data)
	return "flow-host:" + hex.EncodeToString(digest[:])
}
