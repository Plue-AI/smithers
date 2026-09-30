package flowhost

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"path"
	"regexp"
	"slices"
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
	environment := make(map[string]string, len(launch.Catalog.Environment)+len(launch.Environment)+8)
	for name, value := range launch.Catalog.Environment {
		environment[name] = value
	}
	for name, value := range launch.Environment {
		if !startEnvironmentName(name, launch.Catalog) || strings.IndexByte(value, 0) >= 0 {
			return ProcessSpec{}, errors.New("flow host start environment names a reserved or invalid variable")
		}
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
	// A seat the repository keys itself keeps that key, as in a workspace; a
	// platform seat's key (set above) is replaced by the pool.
	routes := AccountPoolGuestRoutes(func(seat AccountPoolSeat) bool {
		return launch.Environment[seat.Seat] != "" && !slices.ContainsFunc(launch.Catalog.ModelSeats, func(platform modelproxy.Seat) bool {
			return launch.Catalog.ModelProxyURL != "" && platform.KeyEnv == seat.Seat
		})
	})
	if launch.Catalog.AccountPoolURL != "" && len(routes) > 0 {
		environment[AccountPoolURLEnv] = launch.Catalog.AccountPoolURL
		environment[AccountPoolProvidersEnv] = strings.Join(routes, ",")
		environment[AccountPoolKeyEnv] = ModelCredential(launch.Binding.ID, launch.Credential)
	}
	// The workspace's own journal database, when the backend keeps journals
	// in PostgreSQL; otherwise the host keeps SQLite in its state directory.
	journal, err := launch.Journal.environment(launch.Binding.WorkspaceID)
	if err != nil {
		return ProcessSpec{}, err
	}
	for name, value := range journal {
		environment[name] = value
	}
	environment["SMITHERS_API_KEY"] = launch.Credential
	environment["SMITHERS_GATEWAY_ID"] = launch.Binding.ID
	environment["SMITHERS_OWNER_GENERATION"] = strconv.FormatInt(launch.Binding.OwnerGeneration, 10)
	environment["SMITHERS_FLOW_ARTIFACT_SHA256"] = launch.Binding.RuntimeArtifactDigest
	environment["SMITHERS_SOURCE_REVISION"] = launch.Binding.SourceRevision
	if launch.Catalog.Family != CatalogCoding {
		return ProcessSpec{}, errors.New("flow host family is unsupported")
	}
	if launch.Catalog.ImplementationModel != "" {
		environment["SMITHERS_CODING_IMPLEMENT_MODEL"] = launch.Catalog.ImplementationModel
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
		// Omitted when empty, so SQLite hosts keep their existing identity.
		Journal string `json:",omitempty"`
	}{launch.Binding.ID, launch.Binding.WorkspaceID, launch.Binding.RuntimeArtifactDigest, launch.Binding.SourceRevision, launch.Binding.OwnerGeneration, launch.Catalog, launch.Authority.Repository, launch.Journal.Name}
	data, _ := json.Marshal(identity)
	digest := sha256.Sum256(data)
	return "flow-host:" + hex.EncodeToString(digest[:])
}

// hostProcessEnvironment is what the runtime and the host own: paths, the
// loader and interpreters' startup hooks, and the JJ configuration the
// runtime clears. A start never supplies them.
var hostProcessEnvironment = map[string]struct{}{
	"HOME": {}, "PATH": {}, "USER": {}, "LOGNAME": {}, "SHELL": {}, "TMPDIR": {}, "PWD": {},
	"XDG_CACHE_HOME": {}, "XDG_CONFIG_HOME": {}, "XDG_DATA_HOME": {}, "XDG_STATE_HOME": {},
	"NODE_OPTIONS": {}, "NODE_PATH": {}, "BUN_OPTIONS": {}, "BASH_ENV": {}, "ENV": {}, "JJ_CONFIG": {},
}

// startEnvironmentName admits a per-start variable (HostLaunch.Environment):
// the landing or build-cache read credential, or a repository variable that
// no catalog, runtime or host setting owns.
func startEnvironmentName(name string, catalog Catalog) bool {
	if _, minted := startCredentialEnvironment[name]; minted {
		return true
	}
	_, configured := catalog.Environment[name]
	return !configured && RepositoryVariable(name)
}

// RepositoryVariable reports whether a repository's agent variable may reach
// its box's coding host: no Smithers, host, loader or database name. A model
// seat's key is set after it, so a repository variable never replaces one.
func RepositoryVariable(name string) bool {
	_, database := databaseEnvironment[name]
	_, process := hostProcessEnvironment[name]
	return !reservedName(name) && !database && !process && !strings.HasPrefix(name, "SMITHERS_") &&
		!strings.HasPrefix(name, "LD_") && !strings.HasPrefix(name, "DYLD_") && startEnvironmentPattern.MatchString(name)
}

var startEnvironmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
