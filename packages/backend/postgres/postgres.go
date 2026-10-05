// Package postgres supervises the private PostgreSQL process of an owned local
// backend. Release packaging supplies binaries; startup never downloads them.
package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
)

const (
	defaultStartupTimeout = 30 * time.Second
	shutdownGrace         = 2 * time.Second
	startAttempts         = 3
)

type Config struct {
	BinDir         string
	StateDir       string
	Major          int
	StartupTimeout time.Duration
}

// Instance owns one process and its lifetime lock. ConnectionString contains a
// credential: never log or format an Instance or expose it to renderer code.
type Instance struct {
	ConnectionString string
	cmd              *exec.Cmd
	done             chan struct{}
	waitErr          error
	lock             *os.File
	log              *os.File
	recordPath       string
	stopOnce         sync.Once
	releaseOnce      sync.Once
}

type processRecord struct {
	PID        int    `json:"pid"`
	DataDir    string `json:"data_dir"`
	Executable string `json:"executable"`
	Birth      string `json:"birth"`
}

type postmasterPID struct {
	PID     int
	DataDir string
	Port    int
	Status  string
}

func Start(ctx context.Context, cfg Config) (_ *Instance, err error) {
	if cfg.BinDir == "" || cfg.StateDir == "" || cfg.Major < 10 {
		return nil, errors.New("postgres requires binary directory, state directory, and explicit major version")
	}
	if cfg.StartupTimeout <= 0 {
		cfg.StartupTimeout = defaultStartupTimeout
	}
	binDir, err := filepath.Abs(cfg.BinDir)
	if err != nil {
		return nil, fmt.Errorf("resolve postgres binary directory: %w", err)
	}
	stateDir, err := filepath.Abs(cfg.StateDir)
	if err != nil {
		return nil, fmt.Errorf("resolve postgres state directory: %w", err)
	}
	cfg.BinDir, cfg.StateDir = binDir, stateDir
	binary := filepath.Join(binDir, "postgres")
	versionCmd := exec.CommandContext(ctx, binary, "--version")
	versionCmd.Env = childEnvironment()
	version, err := versionCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("read packaged postgres version: %w", err)
	}
	match := regexp.MustCompile(`PostgreSQL\) ([0-9]+)(?:\.|\s|$)`).FindStringSubmatch(string(version))
	if len(match) != 2 || match[1] != strconv.Itoa(cfg.Major) {
		return nil, errors.New("packaged postgres major version does not match configuration")
	}
	for _, name := range []string{"initdb", "pg_isready", "psql", "pg_dump", "pg_restore"} {
		if info, statErr := os.Stat(filepath.Join(binDir, name)); statErr != nil || info.IsDir() || info.Mode()&0111 == 0 {
			return nil, fmt.Errorf("packaged postgres tool %s is unavailable", name)
		}
	}
	if err := privateDirectory(stateDir); err != nil {
		return nil, err
	}
	lock, err := acquireLock(filepath.Join(stateDir, "owner.lock"))
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = lock.Close()
		}
	}()

	data := filepath.Join(stateDir, "data")
	recordPath := filepath.Join(stateDir, "postmaster.owner.json")
	if err := reclaimOrphan(ctx, recordPath, data, binary); err != nil {
		return nil, err
	}
	// A supervisor can die between creating and renaming the owner record. The
	// ownership lock proves no live supervisor can still be writing this file.
	if err := os.Remove(recordPath + ".tmp"); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove stale postgres owner record staging: %w", err)
	}
	if err := removeStagingDirectories(stateDir); err != nil {
		return nil, err
	}
	initialized, err := validateDataDirectory(data, cfg.Major)
	if err != nil {
		return nil, err
	}
	passwordFile := filepath.Join(stateDir, "password")
	password, err := loadPassword(passwordFile, !initialized)
	if err != nil {
		return nil, err
	}
	log, err := rotateLog(stateDir)
	if err != nil {
		return nil, err
	}
	defer func() {
		if !keep {
			_ = log.Close()
		}
	}()
	if !initialized {
		if err := initialize(ctx, cfg, data, passwordFile, log); err != nil {
			return nil, err
		}
	}

	var lastErr error
	for attempt := 1; attempt <= startAttempts; attempt++ {
		instance, retry, startErr := startOnce(ctx, cfg, data, binary, password, lock, log, recordPath)
		if startErr == nil {
			keep = true
			return instance, nil
		}
		lastErr = startErr
		if !retry {
			break
		}
	}
	return nil, lastErr
}

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("postgres state path must be a directory, not a symbolic link")
	}
	if info.Mode().Perm() != 0700 {
		if err := os.Chmod(path, 0700); err != nil {
			return fmt.Errorf("make postgres state directory private: %w", err)
		}
	}
	return nil
}

func validateDataDirectory(data string, major int) (bool, error) {
	pgVersion, readErr := os.ReadFile(filepath.Join(data, "PG_VERSION"))
	switch {
	case readErr == nil:
		if strings.TrimSpace(string(pgVersion)) != strconv.Itoa(major) {
			return false, errors.New("postgres data major version differs; explicit upgrade required")
		}
		return true, nil
	case !os.IsNotExist(readErr):
		return false, fmt.Errorf("read postgres data version: %w", readErr)
	default:
		entries, err := os.ReadDir(data)
		if err != nil && !os.IsNotExist(err) {
			return false, err
		}
		if len(entries) != 0 {
			return false, errors.New("postgres data directory is nonempty without PG_VERSION; preserve it for recovery")
		}
		return false, nil
	}
}

func loadPassword(path string, create bool) ([]byte, error) {
	password, err := os.ReadFile(path)
	if os.IsNotExist(err) && create {
		bytes := make([]byte, 32)
		if _, err := rand.Read(bytes); err != nil {
			return nil, err
		}
		password = []byte(hex.EncodeToString(bytes))
		file, openErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if openErr != nil {
			return nil, openErr
		}
		_, writeErr := file.Write(password)
		syncErr := file.Sync()
		closeErr := file.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, errors.New("postgres credential file unavailable; restore the original credential before starting")
	}
	if len(password) != 64 {
		return nil, errors.New("postgres credential file is invalid")
	}
	if _, err := hex.DecodeString(string(password)); err != nil {
		return nil, errors.New("postgres credential file is invalid")
	}
	return password, nil
}

func rotateLog(stateDir string) (*os.File, error) {
	current := filepath.Join(stateDir, "postgres.log")
	previous := current + ".1"
	if err := os.Remove(previous); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.Rename(current, previous); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	return os.OpenFile(current, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
}

func initialize(ctx context.Context, cfg Config, data, passwordFile string, log io.Writer) error {
	staging, err := os.MkdirTemp(cfg.StateDir, "data.init-")
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()
	initCtx, cancel := context.WithTimeout(ctx, cfg.StartupTimeout)
	defer cancel()
	cmd := exec.Command(filepath.Join(cfg.BinDir, "initdb"), "-D", staging, "--username=smithers", "--pwfile="+passwordFile, "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C", "--data-checksums")
	cmd.Env = childEnvironment()
	cmd.Stdout, cmd.Stderr = log, log
	if err := runBounded(initCtx, cmd); err != nil {
		return fmt.Errorf("initialize postgres (staging removed; see postgres.log): %w", err)
	}
	if entries, readErr := os.ReadDir(data); readErr == nil && len(entries) == 0 {
		if err := os.Remove(data); err != nil {
			return fmt.Errorf("replace empty postgres data directory: %w", err)
		}
	} else if readErr != nil && !os.IsNotExist(readErr) {
		return readErr
	} else if readErr == nil {
		return errors.New("postgres data directory appeared during initialization")
	}
	if err := os.Rename(staging, data); err != nil {
		return fmt.Errorf("commit initialized postgres data: %w", err)
	}
	if err := syncDirectory(cfg.StateDir); err != nil {
		return fmt.Errorf("sync initialized postgres data: %w", err)
	}
	committed = true
	return nil
}

func startOnce(ctx context.Context, cfg Config, data, binary string, password []byte, lock, log *os.File, recordPath string) (*Instance, bool, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, false, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	cmd := exec.Command(binary, "-D", data, "-h", "127.0.0.1", "-p", strconv.Itoa(port), "-k", "", "-c", "max_connections=60")
	cmd.Env = childEnvironment()
	cmd.Stdout, cmd.Stderr = log, log
	configurePostmaster(cmd)
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}
	birth, executable, identityErr := processIdentity(cmd.Process.Pid)
	if identityErr != nil {
		_ = signalProcessGroup(cmd.Process.Pid, os.Kill)
		_ = cmd.Wait()
		return nil, false, fmt.Errorf("record postgres process identity: %w", identityErr)
	}
	record := processRecord{PID: cmd.Process.Pid, DataDir: data, Executable: executable, Birth: birth}
	if err := writeRecord(recordPath, record); err != nil {
		_ = signalProcessGroup(cmd.Process.Pid, os.Kill)
		_ = cmd.Wait()
		return nil, false, fmt.Errorf("persist postgres process identity: %w", err)
	}
	instance := &Instance{cmd: cmd, done: make(chan struct{}), lock: lock, log: log, recordPath: recordPath}
	go func() {
		instance.waitErr = cmd.Wait()
		close(instance.done)
	}()
	failed := true
	defer func() {
		if failed {
			stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = instance.stopProcess(stopCtx)
			removeRecordForPID(recordPath, cmd.Process.Pid)
		}
	}()
	startupCtx, cancel := context.WithTimeout(ctx, cfg.StartupTimeout)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-startupCtx.Done():
			return nil, false, fmt.Errorf("postgres startup: %w", startupCtx.Err())
		case <-instance.done:
			retry := logShowsBindFailure(filepath.Join(cfg.StateDir, "postgres.log"))
			return nil, retry, fmt.Errorf("postgres exited before readiness (see postgres.log): %v", instance.waitErr)
		case <-ticker.C:
			pidFile, readErr := readPostmasterPID(filepath.Join(data, "postmaster.pid"))
			if readErr != nil || pidFile.PID != cmd.Process.Pid || pidFile.DataDir != data || pidFile.Port != port || pidFile.Status != "ready" {
				continue
			}
			probe := exec.CommandContext(startupCtx, filepath.Join(cfg.BinDir, "pg_isready"), "-h", "127.0.0.1", "-p", strconv.Itoa(port), "-U", "smithers", "-d", "postgres", "-t", "1")
			probe.Env = childEnvironment()
			if probe.Run() != nil {
				continue
			}
			select {
			case <-instance.done:
				return nil, false, errors.New("postgres stopped during readiness")
			default:
			}
			connection := url.URL{Scheme: "postgres", User: url.UserPassword("smithers", string(password)), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), Path: "/postgres", RawQuery: "sslmode=disable"}
			instance.ConnectionString = connection.String()
			failed = false
			return instance, false, nil
		}
	}
}

// Done closes if the supervised postmaster exits, including an unexpected crash.
func (i *Instance) Done() <-chan struct{} { return i.done }

// Err reports the postmaster wait result after Done closes.
func (i *Instance) Err() error {
	select {
	case <-i.done:
		return i.waitErr
	default:
		return errors.New("postgres is still running")
	}
}

// Stop requests fast shutdown. On deadline it requests immediate shutdown and
// finally kills the owned process group. A forced stop may need WAL recovery.
func (i *Instance) Stop(ctx context.Context) error {
	err := i.stopProcess(ctx)
	i.release()
	return err
}

func (i *Instance) stopProcess(ctx context.Context) error {
	select {
	case <-i.done:
		return i.waitErr
	default:
	}
	i.stopOnce.Do(func() { _ = i.cmd.Process.Signal(os.Interrupt) })
	select {
	case <-i.done:
		return i.waitErr
	case <-ctx.Done():
	}
	select {
	case <-i.done:
		return i.waitErr
	default:
	}
	_ = i.cmd.Process.Signal(immediateShutdownSignal())
	timer := time.NewTimer(shutdownGrace)
	defer timer.Stop()
	select {
	case <-i.done:
		return fmt.Errorf("postgres required immediate shutdown: %w", ctx.Err())
	case <-timer.C:
	}
	_ = signalProcessGroup(i.cmd.Process.Pid, os.Kill)
	<-i.done
	return fmt.Errorf("postgres required forced process-group shutdown: %w", ctx.Err())
}

func (i *Instance) release() {
	i.releaseOnce.Do(func() {
		removeRecordForPID(i.recordPath, i.cmd.Process.Pid)
		_ = i.lock.Close()
		_ = i.log.Close()
	})
}

func reclaimOrphan(ctx context.Context, recordPath, data, binary string) error {
	pidFile, err := readPostmasterPID(filepath.Join(data, "postmaster.pid"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read existing postgres owner: %w", err)
	}
	alive, err := processAlive(pidFile.PID)
	if err != nil {
		return fmt.Errorf("inspect existing postgres process: %w", err)
	}
	if !alive {
		removeRecordForPID(recordPath, pidFile.PID)
		return nil
	}
	recordBytes, err := os.ReadFile(recordPath)
	if err != nil {
		return errors.New("live postgres has no verifiable Smithers owner record; stop it manually before starting")
	}
	var record processRecord
	if json.Unmarshal(recordBytes, &record) != nil || record.PID != pidFile.PID || record.DataDir != data || pidFile.DataDir != data {
		return errors.New("live postgres owner record does not match its data directory; refusing to signal it")
	}
	wantBinary, err := filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("resolve packaged postgres executable: %w", err)
	}
	birth, executable, err := processIdentity(record.PID)
	if err != nil || birth != record.Birth || executable != record.Executable || executable != wantBinary {
		return errors.New("postgres PID was reused or its identity changed; refusing to signal it")
	}
	if err := signalAndWait(ctx, record.PID); err != nil {
		return fmt.Errorf("reclaim orphaned postgres: %w", err)
	}
	removeRecordForPID(recordPath, record.PID)
	return nil
}

func signalAndWait(ctx context.Context, pid int) error {
	if err := signalPID(pid, os.Interrupt); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	if waitProcess(ctx, pid, 10*time.Second) {
		return nil
	}
	_ = signalPID(pid, immediateShutdownSignal())
	if waitProcess(ctx, pid, shutdownGrace) {
		return nil
	}
	_ = signalProcessGroup(pid, os.Kill)
	if waitProcess(ctx, pid, shutdownGrace) {
		return nil
	}
	return errors.New("owned postgres process did not exit")
}

func waitProcess(ctx context.Context, pid int, limit time.Duration) bool {
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		alive, _ := processAlive(pid)
		if !alive {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
}

func readPostmasterPID(path string) (postmasterPID, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return postmasterPID{}, err
	}
	lines := strings.Split(string(contents), "\n")
	if len(lines) < 8 {
		return postmasterPID{}, errors.New("postgres postmaster.pid is incomplete")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil || pid <= 1 {
		return postmasterPID{}, errors.New("postgres postmaster.pid has an invalid PID")
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[3]))
	if err != nil || port <= 0 || port > 65535 {
		return postmasterPID{}, errors.New("postgres postmaster.pid has an invalid port")
	}
	data, err := filepath.Abs(strings.TrimSpace(lines[1]))
	if err != nil {
		return postmasterPID{}, errors.New("postgres postmaster.pid has an invalid data directory")
	}
	return postmasterPID{PID: pid, DataDir: data, Port: port, Status: strings.TrimSpace(lines[7])}, nil
}

func writeRecord(path string, record processRecord) error {
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	syncErr := file.Sync()
	closeErr := file.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		_ = os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func removeRecordForPID(path string, pid int) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var record processRecord
	if json.Unmarshal(contents, &record) == nil && record.PID == pid {
		_ = os.Remove(path)
	}
}

func removeStagingDirectories(stateDir string) error {
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "data.init-") {
			if err := os.RemoveAll(filepath.Join(stateDir, entry.Name())); err != nil {
				return fmt.Errorf("remove stale postgres initialization staging: %w", err)
			}
		}
	}
	return nil
}

// childEnvironment is every PostgreSQL program's whole environment: the
// C locale and HOME, PATH and TMPDIR from the base environment the backend
// built (hostexec), never its inherited one.
func childEnvironment() []string {
	env := []string{"LANG=C", "LC_ALL=C"}
	for _, name := range []string{"HOME", "PATH", "TMPDIR"} {
		if value, ok := hostexec.Lookup(name); ok {
			env = append(env, name+"="+value)
		}
	}
	return env
}

func logShowsBindFailure(path string) bool {
	contents, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	text := string(contents)
	return strings.Contains(text, "could not bind") || strings.Contains(text, "Address already in use")
}
