package modelhost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/ports"
	"github.com/smithersai/smithers/packages/backend/workspace"
)

const protocol = "smithers.chat-model-host/v1"

// workspacePrefix marks the per-turn workspaces this launcher owns.
const workspacePrefix = "chat-model-"

var credentialNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$`)

type LocalConfig struct {
	Runtime    workspace.WorkspaceRuntime
	NodeBinary string
	BundlePath string
}

// LocalLauncher starts one verified TypeScript host per turn in a trusted
// workspace. The service spec, including its environment, stays in memory;
// only the secret-free workspace ID is durable. Plue can reuse Host with a
// launcher that opens its isolated workspace's private HTTP transport.
type LocalLauncher struct {
	runtime workspace.WorkspaceRuntime
	node    string
	bundle  string
	mu      sync.Mutex
	active  map[string]struct{}
}

func NewLocalLauncher(config LocalConfig) (*LocalLauncher, error) {
	if config.Runtime == nil || config.Runtime.Isolation() != workspace.IsolationTrustedProcess {
		return nil, errors.New("local model host requires a trusted process runtime")
	}
	if err := verifyExecutable(config.NodeBinary); err != nil {
		return nil, fmt.Errorf("verify packaged Node: %w", err)
	}
	if err := verifyBundle(config.BundlePath); err != nil {
		return nil, fmt.Errorf("verify packaged model host: %w", err)
	}
	launcher := &LocalLauncher{runtime: config.Runtime, node: config.NodeBinary, bundle: config.BundlePath, active: make(map[string]struct{})}
	if err := launcher.removeOrphans(); err != nil {
		return nil, fmt.Errorf("remove model host workspaces left by a previous process: %w", err)
	}
	return launcher, nil
}

// workspaceLister is implemented by runtimes that can enumerate the
// workspaces they reloaded after a restart.
type workspaceLister interface {
	WorkspaceIDs() []string
}

// removeOrphans deletes per-turn workspaces that a crashed or killed process
// never cleaned up. Only this launcher creates workspaces with its prefix, and
// no turn is active before the launcher exists.
func (launcher *LocalLauncher) removeOrphans() error {
	lister, ok := launcher.runtime.(workspaceLister)
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	var result error
	for _, id := range lister.WorkspaceIDs() {
		if strings.HasPrefix(id, workspacePrefix) {
			result = errors.Join(result, launcher.runtime.DeleteWorkspace(ctx, id))
		}
	}
	return result
}

func verifyExecutable(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("executable path must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("executable must be a regular executable file")
	}
	return nil
}

func verifyBundle(path string) error {
	if err := verifyExecutable(path); err != nil {
		return err
	}
	checksum := path + ".sha256"
	info, err := os.Lstat(checksum)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 256 {
		return errors.New("model host checksum must be a small regular file")
	}
	content, err := os.ReadFile(checksum)
	if err != nil {
		return err
	}
	fields := strings.Fields(string(content))
	if len(fields) != 2 || fields[1] != filepath.Base(path) || len(fields[0]) != 64 {
		return errors.New("model host checksum has invalid format")
	}
	want, err := hex.DecodeString(fields[0])
	if err != nil || fields[0] != strings.ToLower(fields[0]) {
		return errors.New("model host checksum has invalid digest")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if !equalDigest(hash.Sum(nil), want) {
		return errors.New("model host bundle checksum mismatch")
	}
	return nil
}

func equalDigest(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var difference byte
	for index := range left {
		difference |= left[index] ^ right[index]
	}
	return difference == 0
}

func credentialEnvironment(binding Binding) (map[string]string, error) {
	name := binding.CredentialName
	if !credentialNamePattern.MatchString(name) || strings.HasSuffix(name, "_ORIGIN") || strings.TrimSpace(binding.CredentialValue) == "" {
		return nil, errors.New("model credential binding is invalid")
	}
	if !json.Valid(binding.Model) || len(binding.Model) == 0 || len(binding.Model) > 64<<10 {
		return nil, errors.New("model binding is invalid")
	}
	builtin := builtinCredential(name)
	envName := name
	if !builtin {
		envName = "SMITHERS_MODEL_KEY_" + name
		if strings.TrimSpace(binding.CredentialOrigin) == "" {
			return nil, errors.New("custom model credential requires a pinned origin")
		}
	}
	environment := map[string]string{envName: binding.CredentialValue}
	if !builtin {
		environment[envName+"_ORIGIN"] = binding.CredentialOrigin
	}
	return environment, nil
}

func (launcher *LocalLauncher) LaunchChatHost(ctx context.Context, grant ports.ChatTurnGrant, binding Binding) (lease Lease, launchErr error) {
	if grant.OwnerID <= 0 || grant.TurnID == "" || grant.ProducerBaseURL == "" {
		return nil, errors.New("chat model host grant is incomplete")
	}
	callback, err := url.Parse(grant.ProducerBaseURL)
	if err != nil || callback.Scheme != "http" || callback.Hostname() != "127.0.0.1" && callback.Hostname() != "localhost" && callback.Hostname() != "::1" {
		return nil, errors.New("local model host callback must be loopback")
	}
	environment, err := credentialEnvironment(binding)
	if err != nil {
		return nil, err
	}
	if binding.Preflight != nil {
		if binding.Preflight.Preflight != nil {
			return nil, errors.New("nested preflight binding is invalid")
		}
		fastEnvironment, err := credentialEnvironment(*binding.Preflight)
		if err != nil {
			return nil, err
		}
		for key, value := range fastEnvironment {
			if existing, ok := environment[key]; ok && existing != value {
				return nil, errors.New("model credential bindings disagree")
			}
			environment[key] = value
		}
		environment["SMITHERS_CHAT_PREFLIGHT_MODEL"] = string(binding.Preflight.Model)
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("create private model host token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)
	environment["SMITHERS_CHAT_PARENT_PID"] = strconv.Itoa(os.Getpid())
	environment["SMITHERS_CHAT_HOST_TOKEN"] = token
	environment["SMITHERS_CHAT_CALLBACK_URL"] = grant.ProducerBaseURL
	environment["SMITHERS_CHAT_MODEL"] = string(binding.Model)
	environment["SMITHERS_CHAT_HOST_PARENT_PID"] = strconv.Itoa(os.Getpid())

	// A fresh workspace per launch prevents a duplicate recovery candidate
	// from tearing down another in-flight host for the same turn.
	workspaceNonce := make([]byte, 16)
	if _, err := rand.Read(workspaceNonce); err != nil {
		return nil, fmt.Errorf("create model workspace identity: %w", err)
	}
	workspaceID := workspacePrefix + hex.EncodeToString(workspaceNonce)
	if _, err := launcher.runtime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: workspaceID}); err != nil {
		return nil, err
	}
	launcher.mu.Lock()
	launcher.active[workspaceID] = struct{}{}
	launcher.mu.Unlock()
	started := false
	defer func() {
		if !started {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
			defer cancel()
			launchErr = errors.Join(launchErr, launcher.cleanup(cleanupCtx, workspaceID))
		}
	}()
	if _, err := launcher.runtime.StartWorkspace(ctx, workspaceID); err != nil {
		return nil, err
	}
	address, port, err := localAddress()
	if err != nil {
		return nil, err
	}
	service, err := launcher.runtime.StartService(ctx, workspaceID, workspace.ServiceSpec{
		Name: "model-host", Identity: grant.TurnID + ":" + strconv.FormatInt(grant.Generation, 10),
		Command:      workspace.Command{Args: []string{launcher.node, launcher.bundle, "serve", "--host", "127.0.0.1", "--port", port}, Environment: environment},
		ReadyAddress: address, ReadyTimeout: 15 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	endpoint := "http://" + service.Address
	client := &http.Client{Timeout: 15 * time.Minute}
	if err := probe(ctx, client, endpoint); err != nil {
		return nil, err
	}
	started = true
	return &localLease{launcher: launcher, workspaceID: workspaceID, endpoint: endpoint, client: client, token: token}, nil
}

func localAddress() (address, port string, err error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", err
	}
	address = listener.Addr().String()
	closeErr := listener.Close()
	if closeErr != nil {
		return "", "", closeErr
	}
	_, port, err = net.SplitHostPort(address)
	return address, port, err
}

func probe(ctx context.Context, client *http.Client, endpoint string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/health", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("probe model host: %w", err)
	}
	defer response.Body.Close()
	var body struct {
		Protocol string `json:"protocol"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 256)).Decode(&body) != nil || body.Protocol != protocol {
		return errors.New("model host protocol identity mismatch")
	}
	return nil
}

type localLease struct {
	launcher    *LocalLauncher
	workspaceID string
	endpoint    string
	client      *http.Client
	token       string
}

func (lease *localLease) Endpoint() (string, *http.Client, string) {
	return lease.endpoint, lease.client, lease.token
}

func (lease *localLease) Close(ctx context.Context) error {
	return lease.launcher.cleanup(ctx, lease.workspaceID)
}

func (launcher *LocalLauncher) cleanup(ctx context.Context, workspaceID string) error {
	stopErr := launcher.runtime.StopService(ctx, workspaceID, "model-host")
	deleteErr := launcher.runtime.DeleteWorkspace(ctx, workspaceID)
	if deleteErr == nil {
		launcher.mu.Lock()
		delete(launcher.active, workspaceID)
		launcher.mu.Unlock()
	}
	return errors.Join(stopErr, deleteErr)
}

// Close retries cleanup for any turn whose first teardown failed. The common
// app calls this only after the dispatcher has joined its active turns.
func (launcher *LocalLauncher) Close(ctx context.Context) error {
	launcher.mu.Lock()
	ids := make([]string, 0, len(launcher.active))
	for id := range launcher.active {
		ids = append(ids, id)
	}
	launcher.mu.Unlock()
	var result error
	for _, id := range ids {
		result = errors.Join(result, launcher.cleanup(ctx, id))
	}
	return result
}
