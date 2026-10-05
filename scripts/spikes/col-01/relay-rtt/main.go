// Oracles: C-SPK-03 steps 2–5 / pass conditions: 64 B and 4096 B, 1000 frames, 20 setups, idle <20 ms and busy <100 ms.
// A disposable harness for the production transports; it never modifies the
// transport implementation and never adopts another lane's sandbox.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/col01/control"
	"github.com/smithersai/smithers/packages/backend/col01/fanout"
	"github.com/smithersai/smithers/packages/backend/col01/measure"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspace "github.com/smithersai/smithers/packages/backend/workspace"
)

const deviation = "Same-Mac headless Chromium tabs use the LAN address, not a second Mac; strict C-SPK-07 is partial. Host profile and competing VMs are recorded; no isolated-host acceptance is claimed."

type harness struct {
	ctx                  context.Context
	runtime              *microsandbox.Runtime
	id                   string
	build, root          string
	rttBridge, docBridge net.Listener
	environment          map[string]any
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "SPIKE FAILED:", err)
		os.Exit(1)
	}
}
func run() (retErr error) {
	mode := flag.String("mode", "all", "all|rtt|keystrokes|snapshot|serve")
	build := flag.String("build", "", "private build directory")
	evidence := flag.String("evidence-root", "", "checks artifact root")
	lan := flag.String("lan", "", "host LAN IPv4 address")
	serveTransport := flag.String("transport", "relay", "transport for serve mode")
	httpPort := flag.Int("http-port", 0, "HTTP port (0 selects a free port)")
	flag.Parse()
	if *build == "" || *evidence == "" || net.ParseIP(*lan) == nil || net.ParseIP(*lan).IsLoopback() {
		return errors.New("build, evidence-root and non-loopback LAN IPv4 are required")
	}
	if !strings.Contains(" all rtt keystrokes snapshot serve ", " "+*mode+" ") {
		return errors.New("invalid mode")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	rttListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer rttListener.Close()
	docListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer docListener.Close()
	port := func(l net.Listener) uint16 { return uint16(l.Addr().(*net.TCPAddr).Port) }
	cpus, err := strconv.Atoi(strings.TrimSpace(command("sysctl", "-n", "hw.perflevel0.physicalcpu")))
	if err != nil {
		return err
	}
	cpus = min(4, max(2, cpus/2))
	memBytes, err := strconv.ParseInt(strings.TrimSpace(command("sysctl", "-n", "hw.memsize")), 10, 64)
	if err != nil {
		return err
	}
	memory := 8192
	if memBytes < 24<<30 {
		memory = 6144
	}
	state, err := os.MkdirTemp(*build, "state-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(state)
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Binary: filepath.Join(*build, "msb-name"), Root: state, CPUs: cpus, MemoryMiB: memory, DiskMiB: 32768, MaxRunningVMs: 1, CommandTimeout: 3 * time.Hour, HostPorts: []uint16{port(rttListener), port(docListener)}})
	if err != nil {
		return err
	}
	defer func() { retErr = errors.Join(retErr, runtime.Close()) }()
	h := &harness{ctx: ctx, runtime: runtime, id: uuid.NewString(), build: *build, root: *evidence, rttBridge: rttListener, docBridge: docListener}
	before := command(filepath.Join(*build, "msb-real"), "list", "--format", "json")
	h.environment = map[string]any{"commit": strings.TrimSpace(command("git", "rev-parse", "HEAD")), "msb_version": command(filepath.Join(*build, "msb-real"), "--version"), "macos": command("sw_vers"), "host_load": command("uptime"), "host_processes": command("ps", "-axo", "pid,pcpu,pmem,comm"), "memory_bytes": memBytes, "performance_cores": command("sysctl", "-n", "hw.perflevel0.physicalcpu"), "physical_cores": command("sysctl", "-n", "hw.physicalcpu"), "host_model": command("sysctl", "-n", "hw.model"), "cpu_brand": command("sysctl", "-n", "machdep.cpu.brand_string"), "hypervisor_available": command("sysctl", "-n", "kern.hv_support"), "free_disk": command("df", "-h", state), "lan_address": *lan, "network": command("ifconfig"), "other_sandboxes_before": json.RawMessage(before), "vm_config": map[string]any{"image": microsandbox.DefaultImage, "vcpus": cpus, "memory_mib": memory, "disk_mib": 32768}, "deviation": deviation, "no_warmup_samples_dropped": true, "percentile_method": "empirical nearest rank"}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	dir03 := filepath.Join(h.root, "C-SPK-03", stamp)
	dir07 := filepath.Join(h.root, "C-SPK-07", stamp)
	for _, dir := range []string{dir03, dir07} {
		if err = os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err = writeJSON(filepath.Join(dir, "env.json"), h.environment); err != nil {
			return err
		}
	}
	fmt.Println("EVIDENCE", dir03, dir07)
	if _, err = runtime.CreateWorkspace(ctx, workspace.WorkspaceSpec{ID: h.id}); err != nil {
		return err
	}
	// The adapter's naming shim maps only this installation's machine names.
	defer func() {
		cleanupCtx, c := context.WithTimeout(context.Background(), 2*time.Minute)
		defer c()
		deleteErr := runtime.DeleteWorkspace(cleanupCtx, h.id)
		retErr = errors.Join(retErr, deleteErr)
		_ = writeJSON(filepath.Join(dir03, "cleanup.json"), map[string]any{"workspace_deleted": deleteErr == nil, "remaining_sandboxes": json.RawMessage(command(filepath.Join(*build, "msb-real"), "list", "--format", "json"))})
	}()
	h.environment["sandboxes_during"] = json.RawMessage(command(filepath.Join(*build, "msb-real"), "list", "--format", "json"))
	h.environment["workspace_id"] = h.id
	// Read-only guest kernel/profile probes, requested by the dispatch. No watcher,
	// per-write attribution, namespace mutation or BPF program is installed.
	profile, profileErr := runtime.ExecuteCommand(ctx, h.id, workspace.Command{Args: []string{
		"python3", "-c", "import json,os,platform; paths=['/sys/kernel/btf/vmlinux','/proc/config.gz','/sys/fs/cgroup/cgroup.controllers','/proc/sys/kernel/unprivileged_userns_clone']; print(json.dumps({'kernel':platform.release(),'machine':platform.machine(),'uid':os.getuid(),'paths':{p:os.path.exists(p) for p in paths},'proc_status':open('/proc/self/status').read()},sort_keys=True))",
	}})
	if profileErr != nil || profile.ExitCode != 0 {
		return fmt.Errorf("guest kernel profile: exit=%d stderr=%s: %v", profile.ExitCode, profile.Stderr, profileErr)
	}
	if err = os.WriteFile(filepath.Join(dir03, "guest-kernel.json"), []byte(profile.Stdout), 0600); err != nil {
		return err
	}
	for _, dir := range []string{dir03, dir07} {
		if err = writeJSON(filepath.Join(dir, "env.json"), h.environment); err != nil {
			return err
		}
	}
	if *mode == "snapshot" {
		retErr = h.snapshots(dir03, cpus)
		cmd := exec.CommandContext(ctx, "node", "scripts/spikes/col-01/result.mjs", dir03, dir07, dir03, *mode)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		return errors.Join(retErr, cmd.Run())
	}
	for _, name := range []string{"echo", "dochost"} {
		binary, err := os.ReadFile(filepath.Join(h.build, "col01-"+name))
		if err != nil {
			return err
		}
		if err = runtime.WriteFile(ctx, h.id, "col01-"+name, binary, 0755); err != nil {
			return err
		}
	}
	if _, err = runtime.StartService(ctx, h.id, workspace.ServiceSpec{Name: "spike-echo", Command: workspace.Command{Args: []string{"/workspace/col01-echo", "listen", "127.0.0.1:19001"}}, ReadyAddress: "127.0.0.1:19001", ReadyTimeout: 30 * time.Second}); err != nil {
		return err
	}
	if *mode == "all" || *mode == "rtt" {
		if err = h.rtt(dir03, cpus); err != nil {
			return err
		}
		if err = control.Run(ctx, runtime, h.id, dir03); err != nil {
			return err
		}
	}
	if *mode == "all" || *mode == "keystrokes" || *mode == "serve" {
		var browserErrors []error
		for _, transport := range []string{"relay", "bridge"} {
			if *mode == "serve" && transport != *serveTransport {
				continue
			}
			if err = h.keystrokes(dir07, transport, *lan, *httpPort, *mode == "serve"); err != nil {
				browserErrors = append(browserErrors, fmt.Errorf("%s keystrokes: %w", transport, err))
			}
		}
		retErr = errors.Join(browserErrors...)
	}
	if *mode == "all" {
		retErr = errors.Join(retErr, h.snapshots(dir03, cpus))
	}
	if *mode != "serve" {
		cmd := exec.CommandContext(ctx, "node", "scripts/spikes/col-01/result.mjs", dir03, dir07, dir03, *mode)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err = cmd.Run(); err != nil {
			retErr = errors.Join(retErr, err)
		}
	}
	return retErr
}

func command(name string, args ...string) string {
	bytes, err := exec.Command(name, args...).Output()
	if err != nil {
		return "command failed: " + err.Error()
	}
	return strings.TrimSpace(string(bytes))
}
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}

func (h *harness) dial(transport, kind string) (net.Conn, error) {
	if transport == "relay" {
		port := uint16(19001)
		if kind == "dochost" {
			port = 19002
		}
		return h.runtime.DialWorkspacePort(h.ctx, h.id, workspace.PortRequest{Port: port, Purpose: workspace.PortPurposeFlowRuntime})
	}
	listener := h.rttBridge
	if kind == "dochost" {
		listener = h.docBridge
	}
	port := listener.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(h.ctx)
	result := make(chan error, 1)
	go func() {
		out, err := h.runtime.ExecuteCommand(ctx, h.id, workspace.Command{Args: []string{"/workspace/col01-" + kind, "dial", fmt.Sprintf("127.0.0.1:%d", port), "/workspace/spike.txt"}})
		if err == nil && out.ExitCode != 0 {
			err = fmt.Errorf("guest dial exit %d: %s", out.ExitCode, out.Stderr)
		}
		result <- err
	}()
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(30 * time.Second))
	conn, err := acceptBridge(listener, kind)
	if err != nil {
		cancel()
		return nil, err
	}
	listener.(*net.TCPListener).SetDeadline(time.Time{})
	return &bridgeConn{Conn: conn, cancel: cancel, result: result}, nil
}

func acceptBridge(listener net.Listener, kind string) (net.Conn, error) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return nil, err
		}
		if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			conn.Close()
			return nil, err
		}
		marker, err := measure.ReadFrame(conn)
		if err != nil || string(marker) != "col01-"+kind {
			conn.Close()
			continue
		}
		if err := conn.SetDeadline(time.Time{}); err != nil {
			conn.Close()
			return nil, err
		}
		return conn, nil
	}
}

type bridgeConn struct {
	net.Conn
	cancel context.CancelFunc
	result <-chan error
}

func (c *bridgeConn) Close() error {
	err := c.Conn.Close()
	c.cancel()
	select {
	case <-c.result:
	case <-time.After(5 * time.Second):
	}
	return err
}

func exchange(conn net.Conn, payload []byte) (int64, error) {
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return 0, err
	}
	start := time.Now()
	if err := measure.WriteFrame(conn, payload); err != nil {
		return 0, err
	}
	echoed, err := measure.ReadFrame(conn)
	elapsed := time.Since(start).Nanoseconds()
	if err != nil {
		return 0, err
	}
	if !bytes.Equal(echoed, payload) {
		return 0, errors.New("lost, reordered or corrupted frame")
	}
	return elapsed, nil
}
func payload(size, seq int) []byte {
	b := make([]byte, size)
	binary.BigEndian.PutUint64(b, uint64(seq))
	for i := 8; i < len(b); i++ {
		b[i] = byte((seq + i*31) % 251)
	}
	return b
}

func (h *harness) rtt(dir string, cpus int) error {
	f, err := os.OpenFile(filepath.Join(dir, "samples.csv"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	csvw := csv.NewWriter(f)
	defer csvw.Flush()
	csvw.Write([]string{"transport", "size", "load", "rtt_ns", "seq", "deviation"})
	cells := []map[string]any{}
	setups := []map[string]any{}
	setupFile, err := os.Create(filepath.Join(dir, "setup.csv"))
	if err != nil {
		return err
	}
	defer setupFile.Close()
	sw := csv.NewWriter(setupFile)
	defer sw.Flush()
	sw.Write([]string{"transport", "seq", "setup_ns", "deviation"})
	for _, transport := range []string{"relay", "bridge"} {
		values := []int64{}
		for i := 0; i < 20; i++ {
			start := time.Now()
			conn, err := h.dial(transport, "echo")
			if err != nil {
				return err
			}
			_, err = exchange(conn, payload(64, i))
			elapsed := time.Since(start).Nanoseconds()
			closeErr := conn.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
			values = append(values, elapsed)
			sw.Write([]string{transport, strconv.Itoa(i), strconv.FormatInt(elapsed, 10), deviation})
		}
		stats, err := measure.Summary(values)
		if err != nil {
			return err
		}
		setups = append(setups, map[string]any{"transport": transport, "stats": stats, "deviation": deviation, "host_load": command("uptime")})
	}
	for _, load := range []string{"idle", "busy"} {
		if load == "busy" {
			args := "for i in"
			for i := 0; i < cpus; i++ {
				args += " " + strconv.Itoa(i)
			}
			args += "; do yes > /dev/null & done; wait"
			if _, err = h.runtime.StartService(h.ctx, h.id, workspace.ServiceSpec{Name: "spike-load", Command: workspace.Command{Args: []string{"sh", "-c", args}}}); err != nil {
				return err
			}
			// Verify load exists, rather than interpreting launch acceptance as busy.
			result, err := h.runtime.ExecuteCommand(h.ctx, h.id, workspace.Command{Args: []string{"sh", "-c", "ps -eo comm | awk '$1 == \"yes\" {n++} END {print n+0}'"}})
			if err != nil {
				return err
			}
			count, err := strconv.Atoi(strings.TrimSpace(result.Stdout))
			if err != nil || count != cpus {
				return fmt.Errorf("guest CPU load expected %d yes workers: %q", cpus, result.Stdout)
			}
			defer h.runtime.StopService(context.Background(), h.id, "spike-load")
		}
		for _, transport := range []string{"relay", "bridge"} {
			conn, err := h.dial(transport, "echo")
			if err != nil {
				return err
			}
			for _, size := range []int{64, 4096} {
				values := make([]int64, 0, 1000)
				for seq := 0; seq < 1000; seq++ {
					ns, err := exchange(conn, payload(size, seq))
					if err != nil {
						conn.Close()
						return err
					}
					values = append(values, ns)
					csvw.Write([]string{transport, strconv.Itoa(size), load, strconv.FormatInt(ns, 10), strconv.Itoa(seq), deviation})
				}
				stats, err := measure.Summary(values)
				if err != nil {
					return err
				}
				cells = append(cells, map[string]any{"transport": transport, "size": size, "load": load, "stats": stats, "deviation": deviation, "host_load": command("uptime")})
				fmt.Printf("RTT %s %s %dB n=%d p50=%.3f p95=%.3f p99=%.3f ms | %s\n", transport, load, size, stats.N, float64(stats.P50NS)/1e6, float64(stats.P95NS)/1e6, float64(stats.P99NS)/1e6, deviation)
			}
			if err = conn.Close(); err != nil {
				return err
			}
		}
	}
	csvw.Flush()
	sw.Flush()
	if err = errors.Join(csvw.Error(), sw.Error()); err != nil {
		return err
	}
	chosen := ""
	best := int64(1 << 62)
	for _, transport := range []string{"relay", "bridge"} {
		valid := true
		maxIdle := int64(0)
		for _, cell := range cells {
			if cell["transport"] != transport {
				continue
			}
			stats := cell["stats"].(measure.Stats)
			limit := int64(20e6)
			if cell["load"] == "busy" {
				limit = 100e6
			} else {
				maxIdle = max(maxIdle, stats.P95NS)
			}
			if stats.N < 1000 || stats.P95NS >= limit {
				valid = false
			}
		}
		if valid && maxIdle < best {
			chosen = transport
			best = maxIdle
		}
	}
	return writeJSON(filepath.Join(dir, "summary.json"), map[string]any{"cells": cells, "connection_setup": setups, "chosen_transport": chosen, "reason": "Choose the passing transport with the smaller worst idle p95; bridge wins a tie only by its measured number, no unmeasured choice.", "local_gate_passed": chosen != "", "strict_status": "partial: see env for host profile and other VMs", "deviation": deviation})
}

func (h *harness) keystrokes(dir, transport, lan string, httpPort int, serveOnly bool) error {
	if transport == "relay" {
		if _, err := h.runtime.StartService(h.ctx, h.id, workspace.ServiceSpec{Name: "spike-dochost", Command: workspace.Command{Args: []string{"/workspace/col01-dochost", "listen", "127.0.0.1:19002", "/workspace/spike.txt"}}, ReadyAddress: "127.0.0.1:19002", ReadyTimeout: 30 * time.Second}); err != nil {
			return err
		}
	}
	guest, err := h.dial(transport, "dochost")
	if err != nil {
		return err
	}
	defer guest.Close()
	server := fanout.New(h.ctx, guest, func(ctx context.Context) ([]byte, error) { return h.runtime.ReadFile(ctx, h.id, "spike.txt") }, h.environment, filepath.Join(h.build, "spike.js"))
	lanListener, err := net.Listen("tcp4", fmt.Sprintf("%s:%d", lan, httpPort))
	if err != nil {
		return err
	}
	defer lanListener.Close()
	port := lanListener.Addr().(*net.TCPAddr).Port
	loopback, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	defer loopback.Close()
	httpServer := &http.Server{Handler: server.Handler(), ReadHeaderTimeout: 5 * time.Second}
	defer httpServer.Close()
	go httpServer.Serve(lanListener)
	go httpServer.Serve(loopback)
	origin := fmt.Sprintf("http://%s:%d", lan, port)
	subdir := filepath.Join(dir, transport)
	if err = os.MkdirAll(subdir, 0700); err != nil {
		return err
	}
	fmt.Printf("BROWSER %s %s | %s\n", transport, origin, deviation)
	if serveOnly {
		fmt.Printf("SECOND MAC: SPIKE_CLIENT_TOPOLOGY=second-mac scripts/spikes/col-01/run.sh remote %s %s\n", origin, transport)
		<-h.ctx.Done()
		return nil
	}
	cmd := playwrightCommand(h.ctx, "test", "--config", "scripts/spikes/col-01/playwright.config.ts")
	cmd.Env = append(os.Environ(), "SPIKE_ORIGIN="+origin, "SPIKE_EVIDENCE="+subdir, "SPIKE_TRANSPORT="+transport, "SPIKE_CLIENT_TOPOLOGY=same-mac")
	log, err := os.Create(filepath.Join(subdir, "playwright.log"))
	if err != nil {
		return err
	}
	defer log.Close()
	cmd.Stdout = io.MultiWriter(os.Stdout, log)
	cmd.Stderr = io.MultiWriter(os.Stderr, log)
	err = cmd.Run()
	// Preserve real save counts/times and final text from the daemon as well.
	response, getErr := http.Get(origin + "/stats")
	if getErr == nil {
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		os.WriteFile(filepath.Join(subdir, "guest-stats.json"), body, 0600)
	}
	return err
}

// Retained for an independent content fingerprint in environment/report tools.
func digest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

func playwrightCommand(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, "node", append([]string{"scripts/spikes/col-01/node_modules/@playwright/test/cli.js"}, args...)...)
}
