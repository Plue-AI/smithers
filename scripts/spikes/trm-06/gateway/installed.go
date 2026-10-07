package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspace "github.com/smithersai/smithers/packages/backend/workspace"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
)

type installedConfig struct {
	Listen  string `json:"listen"`
	HostKey string `json:"host_key"`
	BenKey  string `json:"ben_key"`
}

func stateRoot() (string, string, error) {
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		return "", "", err
	}
	home, err := installbundle.ProtectedDirectory("account home", account.HomeDir)
	if err != nil {
		return "", "", err
	}
	return filepath.Join(home, ".local", "state", "smithers", "trm06"), home, nil
}
func readState(path string, limit int64) ([]byte, error) {
	// Walk from / through held no-follow descriptors; validate each inode. This
	// avoids validate-then-reopen races in caller-controlled config/key entries.
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	components := bytes.Split([]byte(filepath.Clean(path)[1:]), []byte("/"))
	for i, component := range components {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
		if i < len(components)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, err := unix.Openat(fd, string(component), flags, 0)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
		var stat unix.Stat_t
		if err = unix.Fstat(fd, &stat); err != nil || !installbundle.TrustedOwnership(stat.Uid, uint32(stat.Mode)) {
			unix.Close(fd)
			return nil, errAuthority
		}
		if i == len(components)-1 && (stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Nlink != 1 || stat.Mode&0777 != 0600) {
			unix.Close(fd)
			return nil, errAuthority
		}
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errAuthority
	}
	return data, nil
}
func loadConfig(root string) (installedConfig, ssh.Signer, ssh.PublicKey, error) {
	var config installedConfig
	data, err := readState(filepath.Join(root, "config.json"), 65536)
	if err != nil {
		return config, nil, nil, err
	}
	if err = decodeStrict(data, &config); err != nil {
		return config, nil, nil, err
	}
	host, port, err := net.SplitHostPort(config.Listen)
	if err != nil || net.ParseIP(host) == nil {
		return config, nil, nil, errAuthority
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1024 || n > 65535 {
		return config, nil, nil, errAuthority
	}
	hostKey, err := ssh.ParsePrivateKey([]byte(config.HostKey))
	if err != nil {
		return config, nil, nil, err
	}
	benKey, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(config.BenKey))
	if err != nil || len(bytes.TrimSpace(rest)) != 0 {
		return config, nil, nil, errAuthority
	}
	return config, hostKey, benKey, nil
}
func installedMain(ctx context.Context, operation string) error {
	if os.Getuid() == 0 || os.Geteuid() == 0 {
		return errAuthority
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	authority, err := loadInstalledAuthority(executable)
	if err != nil {
		return authorityError(err)
	}
	root, home, err := stateRoot()
	if err != nil {
		return err
	}
	if err = os.Chdir("/"); err != nil {
		return err
	}
	config, hostKey, benKey, err := loadConfig(root)
	if err != nil {
		return err
	}
	if operation == "check-install" || operation == "check-session" {
		return runRootValidation(ctx, authority, root, home, operation)
	}
	if operation == "measure" {
		return runMeasurements(ctx, authority, root, config, hostKey.PublicKey())
	}
	if operation == "flow" {
		return runFlowProbe(ctx, root, config, hostKey.PublicKey())
	}
	if operation == "revoke" {
		return requestInstalledRevocation(ctx, filepath.Join(root, "control.sock"))
	}
	if operation != "run" {
		return errors.New("usage: trm06-gateway run|revoke")
	}
	lock, err := lockRun(root)
	if err != nil {
		return err
	}
	defer lock.Close()
	socketPath := filepath.Join(root, "control.sock")
	if info, err := os.Lstat(socketPath); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSocket == 0 || int(stat.Uid) != os.Getuid() {
			return errAuthority
		}
		if err = os.Remove(socketPath); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// Config/root/keys/approval are all checked before a VM, socket or process.
	if err = authority.recheck(); err != nil {
		return err
	}
	cfg := freshConfig()
	cfg.Bundle = authority.bundle
	cfg.Root = filepath.Join(root, "runtime")
	runtime, err := microsandbox.New(ctx, cfg)
	if err != nil {
		return err
	}
	defer runtime.Close()
	var token [16]byte
	if _, err = rand.Read(token[:]); err != nil {
		return err
	}
	workspaceID := "trm06-" + hex.EncodeToString(token[:])
	if _, err = runtime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: workspaceID}); err != nil {
		return err
	}
	// A disposable run always removes its fresh machine, including startup failure.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		_ = runtime.DeleteWorkspace(cleanup, workspaceID)
	}()
	identity := bootIdentity{}
	if _, err = rand.Read(identity.Boot[:]); err != nil {
		return err
	}
	if _, err = rand.Read(identity.Secret[:]); err != nil {
		return err
	}
	if err = installPrototype(ctx, authority, workspaceID, home, cfg.Root, identity); err != nil {
		return err
	}
	control := relayControl{runtime: runtime, workspaceID: workspaceID, authenticate: identity.authenticate, faults: &relayFaults{}}
	observer := func(c context.Context, mode string) ([]byte, error) {
		source, entry, err := authority.bundle.Read("share/trm06/validation.py", 65536)
		if err != nil {
			return nil, err
		}
		if entry.Mode != 0644 || entry.Stage != "host" {
			return nil, errAuthority
		}
		hash := sha256.Sum256([]byte(workspaceID))
		data, err := readState(filepath.Join(cfg.Root, "workspaces", hex.EncodeToString(hash[:]), "metadata.json"), 65536)
		if err != nil {
			return nil, err
		}
		var metadata struct {
			ID      string `json:"id"`
			Machine string `json:"machine"`
		}
		if json.Unmarshal(data, &metadata) != nil || metadata.ID != workspaceID {
			return nil, errAuthority
		}
		return runGuestFixture(c, authority, home, metadata.Machine, string(source), mode)
	}
	// The init PID is not readiness. Wait for an authenticated real relay proof.
	ready, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		connection, openErr := control.connect(ready)
		if openErr == nil {
			connection.Close()
			break
		}
		select {
		case <-ready.Done():
			return ready.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	admin := newAdminControl(ctx, control.connect)
	defer admin.close()
	if err = admin.ensure(ready); err != nil {
		return err
	}
	go admin.watch()
	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return err
	}
	controlSocket, err := net.Listen("unix", filepath.Join(root, "control.sock"))
	if err != nil {
		listener.Close()
		return err
	}
	defer controlSocket.Close()
	defer os.Remove(filepath.Join(root, "control.sock"))
	if err = os.Chmod(filepath.Join(root, "control.sock"), 0600); err != nil {
		listener.Close()
		return err
	}
	requests := make(chan revocationRequest, 1)
	gatewayCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	go serveRevocation(gatewayCtx, controlSocket, requests, &ownerControl{control.faults, observer})
	fmt.Printf("{\"ready\":true,\"listen\":%q,\"workspace\":%q,\"revision\":%q}\n", listener.Addr().String(), workspaceID, authority.bundle.Revision())
	gatewayResult := serveGateway(gatewayCtx, listener, func(c context.Context) listenerAuthority {
		return listenerAuthority{hostKey, benKey, func(spec *open) (io.ReadWriteCloser, error) {
			if err := authority.recheck(); err != nil {
				return nil, err
			}
			if err := admin.ensure(c); err != nil {
				return nil, err
			}
			return control.opener(c)(spec)
		}}
	}, admin.revoke, requests)
	// Preserve independent guest kernel observations before deleting the VM;
	// VM destruction must never masquerade as a passing revocation sample.
	sampleCtx, sampleCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer sampleCancel()
	sample, sampleErr := observer(sampleCtx, "drain")
	receipt := map[string]any{"sample": json.RawMessage(sample), "gateway_error": "", "observer_error": "", "observed_utc": time.Now().UTC().Format(time.RFC3339Nano)}
	if gatewayResult != nil {
		receipt["gateway_error"] = gatewayResult.Error()
	}
	if sampleErr != nil {
		receipt["observer_error"] = sampleErr.Error()
		receipt["sample"] = nil
	}
	body, _ := json.Marshal(receipt)
	_ = os.WriteFile(filepath.Join(root, "last-drain.json"), body, 0600)
	return gatewayResult
}
func installPrototype(ctx context.Context, a *installedAuthority, workspaceID, home, root string, identity bootIdentity) error {
	if err := a.recheck(); err != nil {
		return err
	}
	// Read the adapter's protected metadata instead of duplicating its private
	// machine-name/ownership algorithm. Never accept a member machine selector.
	hash := sha256.Sum256([]byte(workspaceID))
	data, err := readState(filepath.Join(root, "workspaces", hex.EncodeToString(hash[:]), "metadata.json"), 65536)
	if err != nil {
		return err
	}
	var metadata struct {
		ID      string `json:"id"`
		Machine string `json:"machine"`
	}
	if json.Unmarshal(data, &metadata) != nil || metadata.ID != workspaceID || metadata.Machine == "" {
		return errAuthority
	}
	payload := struct {
		Supervisor []byte `json:"supervisor"`
		SHA        string `json:"sha256"`
		Boot       any    `json:"boot"`
	}{a.supervisor, a.supervisorSHA, map[string]any{"revision": a.bundle.Revision(), "supervisor_sha256": a.supervisorSHA, "boot": byteNumbers(identity.Boot[:]), "secret": byteNumbers(identity.Secret[:])}}
	input, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = runGuestInstalled(ctx, a, home, metadata.Machine, string(a.installer), input)
	return err
}
func runGuestInstalled(ctx context.Context, a *installedAuthority, home, machine, script string, input []byte) ([]byte, error) {
	if err := a.recheck(); err != nil {
		return nil, err
	}
	var err error
	msb := a.bundle.Program("bin/msb")
	if err = msb.Check(); err != nil {
		return nil, err
	}
	for _, path := range a.bundle.Matching("lib/libkrunfw*.dylib") {
		if err = a.bundle.Library(path).Check(); err != nil {
			return nil, err
		}
		if err = a.bundle.Absent(filepath.Join("bin", filepath.Base(path))); err != nil {
			return nil, err
		}
	}

	command := exec.CommandContext(ctx, msb.Path(), "exec", "--stream", machine, "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "/usr/bin/python3", "-I", "-S", "-c", script)
	command.Dir = "/"
	command.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
	command.Stdin = bytes.NewReader(input)
	command.WaitDelay = 2 * time.Second
	output, err := command.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("installed guest operation failed: %w (%s)", err, output)
	}
	return output, nil
}

func byteNumbers(bytes []byte) []int {
	values := make([]int, len(bytes))
	for i, b := range bytes {
		values[i] = int(b)
	}
	return values
}
func serveRevocation(ctx context.Context, listener net.Listener, requests chan<- revocationRequest, controls ...*ownerControl) {
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		stopConnection := context.AfterFunc(ctx, func() { connection.Close() })
		connection.SetDeadline(time.Now().Add(6 * time.Second))
		var request []byte
		for len(request) < 32 {
			var b [1]byte
			if _, err = io.ReadFull(connection, b[:]); err != nil {
				break
			}
			request = append(request, b[0])
			if b[0] == '\n' {
				break
			}
		}
		if err == nil && (string(request) == "lost-window\n" || string(request) == "delivered-eof\n") && len(controls) == 1 && controls[0] != nil && controls[0].faults != nil {
			mode := string(request[:len(request)-1])
			if controls[0].faults.arm(mode) == nil {
				_ = writeAll(connection, []byte("armed\n"))
			} else {
				_ = writeAll(connection, []byte("refused\n"))
			}
			stopConnection()
			connection.Close()
			continue
		}
		if err == nil && string(request) == "cut-relay\n" && len(controls) == 1 && controls[0] != nil && controls[0].faults != nil {
			controls[0].faults.cut(10 * time.Second)
			_ = writeAll(connection, []byte("cut\n"))
			stopConnection()
			connection.Close()
			continue
		}
		if err == nil && (string(request) == "sample\n" || string(request) == "restart\n" || string(request) == "arm\n" || string(request) == "drain\n") && len(controls) == 1 && controls[0] != nil && controls[0].observe != nil {
			mode := "sample"
			if string(request) == "restart\n" {
				mode = "restart"
			}
			if string(request) == "arm\n" {
				mode = "arm"
			}
			if string(request) == "drain\n" {
				mode = "drain"
			}
			sampling, cancelSample := context.WithTimeout(ctx, 5*time.Second)
			body, observeErr := controls[0].observe(sampling, mode)
			cancelSample()
			if observeErr != nil {
				body = []byte(`{"class":"unavailable","code":"observer_unavailable"}`)
			}
			_ = writeAll(connection, append(bytes.TrimSpace(body), '\n'))
			stopConnection()
			connection.Close()
			continue
		}
		if err != nil || string(request) != "revoke\n" {
			stopConnection()
			connection.Close()
			continue
		}
		reply := make(chan error, 1)
		select {
		case requests <- revocationRequest{reply}:
		case <-ctx.Done():
			connection.Close()
			return
		}
		select {
		case err = <-reply:
			if err == nil {
				_ = writeAll(connection, []byte("drained\n"))
			} else {
				_ = writeAll(connection, []byte("failed\n"))
			}
		case <-ctx.Done():
		}
		stopConnection()
		connection.Close()
		return
	}
}
func requestInstalledRevocation(ctx context.Context, path string) error {
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
	if err != nil {
		return err
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(6 * time.Second))
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	if err = writeAll(connection, []byte("revoke\n")); err != nil {
		return err
	}
	var reply [8]byte
	if _, err = io.ReadFull(connection, reply[:]); err != nil {
		return err
	}
	if string(reply[:]) != "drained\n" {
		return errors.New("guest drain not confirmed")
	}
	return nil
}

func lockRun(root string) (*os.File, error) {
	if _, err := installbundle.ProtectedDirectory("prototype state", root); err != nil {
		return nil, err
	}
	fd, err := unix.Open(filepath.Join(root, "run.lock"), unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "run.lock")
	var stat unix.Stat_t
	if err = unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || !installbundle.TrustedOwnership(stat.Uid, uint32(stat.Mode)) || stat.Nlink != 1 {
		file.Close()
		return nil, errAuthority
	}
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("prototype already running")
	}
	return file, nil
}

type ownerControl struct {
	faults  *relayFaults
	observe func(context.Context, string) ([]byte, error)
}
