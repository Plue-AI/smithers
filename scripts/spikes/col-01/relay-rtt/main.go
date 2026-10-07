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
	goruntime "runtime"
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

// rttDeviation stamps load-gated RTT rows. The gate is a literal harness
// fixture: a cell starts only when the host 1-minute load, less the guest's own
// busy workers, is below loadCeiling; a cell whose closing load reaches the
// ceiling is retained in samples-rejected.csv and rerun.
const rttDeviation = "Load-gated: each cell starts below 1-min host load 10 (guest busy workers subtracted) and is rerun if it ends at or above 10; rejected attempts are kept in samples-rejected.csv. Load and running VMs are recorded per cell."

const (
	loadCeiling     = 10.0
	loadPoll        = 15 * time.Second
	loadWaitLimit   = 3 * time.Hour
	maxCellAttempts = 5
)

// nodelayPorts maps each diagnostic transport to the guest loopback port of
// one spike-only copy of the helper's bridge (echo/bridge_nodelay.py) and the
// sockets that copy sets TCP_NODELAY on. Setting one socket at a time
// attributes the 4 KiB stall; `none` must reproduce the shipped helper.
var nodelayPorts = map[string]struct {
	port    int
	sockets string
}{
	"bridge-nodelay":          {19003, "both"},
	"bridge-nodelay-client":   {19004, "client"},
	"bridge-nodelay-upstream": {19005, "upstream"},
	"bridge-nodelay-none":     {19006, "none"},
}

type harness struct {
	ctx                  context.Context
	runtime              *microsandbox.Runtime
	id                   string
	build, root          string
	rttBridge, docBridge net.Listener
	environment          map[string]any
}

// hostLoad reads the 1/5/15-minute load averages ("{ 5.82 7.41 6.36 }").
func hostLoad() ([3]float64, error) { return parseLoadavg(command("sysctl", "-n", "vm.loadavg")) }

func parseLoadavg(text string) ([3]float64, error) {
	var load [3]float64
	fields := strings.Fields(strings.Trim(text, "{} \n"))
	if len(fields) != 3 {
		return load, fmt.Errorf("unexpected vm.loadavg %q", fields)
	}
	for i, field := range fields {
		value, err := strconv.ParseFloat(field, 64)
		if err != nil {
			return load, err
		}
		load[i] = value
	}
	return load, nil
}

// runningVMs counts every msb sandbox that is not stopped, including ours.
func runningVMs(msb string) (int, []string) {
	var list []map[string]any
	if err := json.Unmarshal([]byte(command(msb, "list", "--format", "json")), &list); err != nil {
		return -1, nil
	}
	names := []string{}
	for _, sandbox := range list {
		if status, _ := sandbox["status"].(string); !strings.EqualFold(status, "stopped") {
			name, _ := sandbox["name"].(string)
			names = append(names, name+":"+status)
		}
	}
	return len(names), names
}

// loadReceipt records host load and running VMs; own is the guest's own busy
// workers, subtracted before comparing with loadCeiling.
func (h *harness) loadReceipt(own int) map[string]any {
	load, err := hostLoad()
	count, names := runningVMs(filepath.Join(h.build, "msb-real"))
	receipt := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "uptime": command("uptime"), "load1": load[0], "load5": load[1], "load15": load[2], "own_guest_workers": own, "gated_load1": load[0] - float64(own), "running_vms": count, "running_vm_names": names}
	if err != nil {
		receipt["load_error"] = err.Error()
		receipt["gated_load1"] = loadCeiling
	}
	return receipt
}

// waitForLoad blocks until the gated 1-minute load is below loadCeiling.
func (h *harness) waitForLoad(label string, own int) (map[string]any, error) {
	start := time.Now()
	for {
		receipt := h.loadReceipt(own)
		if receipt["gated_load1"].(float64) < loadCeiling {
			receipt["waited_s"] = time.Since(start).Seconds()
			return receipt, nil
		}
		if time.Since(start) > loadWaitLimit {
			return receipt, fmt.Errorf("%s: host load stayed at or above %.0f for %s: %s", label, loadCeiling, loadWaitLimit, receipt["uptime"])
		}
		fmt.Printf("LOAD WAIT %s: %s\n", label, receipt["uptime"])
		select {
		case <-h.ctx.Done():
			return receipt, h.ctx.Err()
		case <-time.After(loadPoll):
		}
	}
}

// sampleLoad appends one host-load row every 10 s until ctx ends.
func (h *harness) sampleLoad(ctx context.Context, path string) {
	f, err := os.Create(path)
	if err != nil {
		return
	}
	defer f.Close()
	w := csv.NewWriter(f)
	w.Write([]string{"utc", "load1", "load5", "load15", "running_vms"})
	for {
		load, _ := hostLoad()
		count, _ := runningVMs(filepath.Join(h.build, "msb-real"))
		w.Write([]string{time.Now().UTC().Format(time.RFC3339), strconv.FormatFloat(load[0], 'f', 2, 64), strconv.FormatFloat(load[1], 'f', 2, 64), strconv.FormatFloat(load[2], 'f', 2, 64), strconv.Itoa(count)})
		w.Flush()
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "SPIKE FAILED:", err)
		os.Exit(1)
	}
}
func run() (retErr error) {
	if os.Geteuid() == 0 || goruntime.GOOS != "darwin" || goruntime.GOARCH != "arm64" {
		return errors.New("reference Apple Silicon non-root host required; no host fallback")
	}
	mode := flag.String("mode", "all", "all|rtt|control|keystrokes|snapshot|serve")
	build := flag.String("build", "", "private build directory")
	evidence := flag.String("evidence-root", "", "checks artifact root")
	lan := flag.String("lan", "", "host LAN IPv4 address")
	serveTransport := flag.String("transport", "relay", "transport for serve mode")
	httpPort := flag.Int("http-port", 0, "HTTP port (0 selects a free port)")
	flag.Parse()
	if *build == "" || *evidence == "" || net.ParseIP(*lan) == nil || net.ParseIP(*lan).IsLoopback() {
		return errors.New("build, evidence-root and non-loopback LAN IPv4 are required")
	}
	if !strings.Contains(" all rtt control keystrokes snapshot serve store ", " "+*mode+" ") {
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
	commandTimeout := 3 * time.Hour
	if *mode == "snapshot" || *mode == "all" {
		commandTimeout = 72 * time.Hour
	}
	state, err := os.MkdirTemp(*build, "state-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(state)
	runtime, err := microsandbox.New(ctx, microsandbox.Config{Binary: filepath.Join(*build, "msb-name"), Root: state, CPUs: cpus, MemoryMiB: memory, DiskMiB: 32768, MaxRunningVMs: 1, CommandTimeout: commandTimeout, HostPorts: []uint16{port(rttListener), port(docListener)}})
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
	gate, err := h.waitForLoad("start", 0)
	if err != nil {
		return err
	}
	h.environment["load_gate_start"] = gate
	h.environment["load_gate"] = map[string]any{"ceiling_load1": loadCeiling, "poll_s": loadPoll.Seconds(), "wait_limit_s": loadWaitLimit.Seconds(), "max_cell_attempts": maxCellAttempts}
	loadDir := dir03
	if *mode == "keystrokes" || *mode == "serve" {
		loadDir = dir07
	}
	sampleCtx, stopSampling := context.WithCancel(ctx)
	defer stopSampling()
	go h.sampleLoad(sampleCtx, filepath.Join(loadDir, "host-load.csv"))
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
		"python3", "-c", "import json,os,platform; paths=['/sys/kernel/btf/vmlinux','/proc/config.gz','/sys/fs/cgroup/cgroup.controllers','/proc/sys/kernel/unprivileged_userns_clone']; print(json.dumps({'kernel':platform.release(),'system':platform.system(),'machine':platform.machine(),'uid':os.getuid(),'paths':{p:os.path.exists(p) for p in paths},'proc_status':open('/proc/self/status').read()},sort_keys=True))",
	}})
	if profileErr != nil || profile.ExitCode != 0 {
		return fmt.Errorf("guest kernel profile: exit=%d stderr=%s: %v", profile.ExitCode, profile.Stderr, profileErr)
	}
	if err = validateGuestProfile([]byte(profile.Stdout)); err != nil {
		return err
	}
	h.environment["host_uid"] = os.Geteuid()
	if err = os.WriteFile(filepath.Join(dir03, "guest-kernel.json"), []byte(profile.Stdout), 0600); err != nil {
		return err
	}
	for _, dir := range []string{dir03, dir07} {
		if err = writeJSON(filepath.Join(dir, "env.json"), h.environment); err != nil {
			return err
		}
	}
	if *mode == "store" {
		return h.prepareStore(dir03)
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
		forwarder, err := os.ReadFile("scripts/spikes/col-01/echo/bridge_nodelay.py")
		if err != nil {
			return err
		}
		if err = runtime.WriteFile(ctx, h.id, "col01-bridge-nodelay.py", forwarder, 0755); err != nil {
			return err
		}
		for _, transport := range rttTransports {
			forwarder, ok := nodelayPorts[transport]
			if !ok {
				continue
			}
			if _, err = runtime.StartService(ctx, h.id, workspace.ServiceSpec{Name: "spike-" + transport, Command: workspace.Command{Args: []string{"python3", "/workspace/col01-bridge-nodelay.py", strconv.Itoa(forwarder.port), strconv.Itoa(int(port(rttListener))), forwarder.sockets}}, ReadyAddress: fmt.Sprintf("127.0.0.1:%d", forwarder.port), ReadyTimeout: 30 * time.Second}); err != nil {
				return err
			}
		}
	}
	if *mode == "all" || *mode == "rtt" {
		if err = h.rtt(dir03, cpus); err != nil {
			return err
		}
	}
	if *mode == "all" || *mode == "rtt" || *mode == "control" {
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
	if forwarder, ok := nodelayPorts[transport]; ok {
		// Same host listener; the guest dials the spike's NODELAY forwarder.
		port = forwarder.port
	}
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

// rttTransports lists the two production transports and the NODELAY diagnostics.
var rttTransports = []string{"relay", "bridge", "bridge-nodelay", "bridge-nodelay-client", "bridge-nodelay-upstream", "bridge-nodelay-none"}

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
	rejected, err := os.Create(filepath.Join(dir, "samples-rejected.csv"))
	if err != nil {
		return err
	}
	defer rejected.Close()
	rw := csv.NewWriter(rejected)
	defer rw.Flush()
	rw.Write([]string{"transport", "size", "load", "rtt_ns", "seq", "attempt", "load1_after"})
	for _, transport := range rttTransports {
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
			sw.Write([]string{transport, strconv.Itoa(i), strconv.FormatInt(elapsed, 10), rttDeviation})
		}
		stats, err := measure.Summary(values)
		if err != nil {
			return err
		}
		setups = append(setups, map[string]any{"transport": transport, "stats": stats, "deviation": rttDeviation, "host_load": h.loadReceipt(0)})
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
		own := 0
		if load == "busy" {
			own = cpus
		}
		for _, transport := range rttTransports {
			conn, err := h.dial(transport, "echo")
			if err != nil {
				return err
			}
			for _, size := range []int{64, 4096} {
				var values []int64
				var before, after map[string]any
				attempt := 1
				for ; ; attempt++ {
					label := fmt.Sprintf("%s %s %dB attempt %d", transport, load, size, attempt)
					if before, err = h.waitForLoad(label, own); err != nil {
						conn.Close()
						return err
					}
					values = make([]int64, 0, 1000)
					for seq := 0; seq < 1000; seq++ {
						ns, err := exchange(conn, payload(size, seq))
						if err != nil {
							conn.Close()
							return err
						}
						values = append(values, ns)
					}
					after = h.loadReceipt(own)
					if after["gated_load1"].(float64) < loadCeiling || attempt == maxCellAttempts {
						break
					}
					fmt.Printf("LOAD REJECT %s: %s\n", label, after["uptime"])
					for seq, ns := range values {
						rw.Write([]string{transport, strconv.Itoa(size), load, strconv.FormatInt(ns, 10), strconv.Itoa(seq), strconv.Itoa(attempt), strconv.FormatFloat(after["load1"].(float64), 'f', 2, 64)})
					}
				}
				for seq, ns := range values {
					csvw.Write([]string{transport, strconv.Itoa(size), load, strconv.FormatInt(ns, 10), strconv.Itoa(seq), rttDeviation})
				}
				stats, err := measure.Summary(values)
				if err != nil {
					return err
				}
				gated := after["gated_load1"].(float64) < loadCeiling
				cells = append(cells, map[string]any{"transport": transport, "size": size, "load": load, "stats": stats, "deviation": rttDeviation, "attempt": attempt, "load_before": before, "load_after": after, "load_gate_held": gated})
				fmt.Printf("RTT %s %s %dB n=%d p50=%.3f p95=%.3f p99=%.3f ms attempt=%d load %.2f->%.2f\n", transport, load, size, stats.N, float64(stats.P50NS)/1e6, float64(stats.P95NS)/1e6, float64(stats.P99NS)/1e6, attempt, before["load1"], after["load1"])
			}
			if err = conn.Close(); err != nil {
				return err
			}
		}
	}
	csvw.Flush()
	sw.Flush()
	rw.Flush()
	if err = errors.Join(csvw.Error(), sw.Error(), rw.Error()); err != nil {
		return err
	}
	chosen := ""
	best := int64(1 << 62)
	gates := map[string]bool{}
	for _, transport := range rttTransports {
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
		gates[transport] = valid
		// bridge-nodelay is a diagnostic of an unshipped helper change; only the
		// two production transports can be chosen.
		if _, diagnostic := nodelayPorts[transport]; !diagnostic && valid && maxIdle < best {
			chosen = transport
			best = maxIdle
		}
	}
	return writeJSON(filepath.Join(dir, "summary.json"), map[string]any{"cells": cells, "connection_setup": setups, "chosen_transport": chosen, "reason": "Choose the passing transport with the smaller worst idle p95; bridge wins a tie only by its measured number, no unmeasured choice.", "local_gate_passed": chosen != "", "gate_passed_by_transport": gates, "diagnostic_transports": map[string]string{"bridge-nodelay": "the guest helper's bridge byte pipe, copied with TCP_NODELAY on both sockets (echo/bridge_nodelay.py); tests the 4 KiB Nagle/delayed-ACK confounder, never chosen", "bridge-nodelay-client": "the same copy with TCP_NODELAY on the accepted guest loopback socket only", "bridge-nodelay-upstream": "the same copy with TCP_NODELAY on the socket to host.microsandbox.internal only", "bridge-nodelay-none": "the same copy with no TCP_NODELAY; a control that must reproduce the shipped helper"}, "strict_status": "partial: see env for host profile and other VMs", "deviation": deviation})
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

// Repository work cannot start before the fresh image's actual identity is known.
func validateGuestProfile(data []byte) error {
	var profile struct {
		UID     *int   `json:"uid"`
		System  string `json:"system"`
		Machine string `json:"machine"`
	}
	if json.Unmarshal(data, &profile) != nil || profile.UID == nil || *profile.UID != 19999 || profile.System != "Linux" || profile.Machine != "aarch64" {
		return errors.New("fresh guest must be Linux ARM64 agent uid 19999 before repository execution")
	}
	return nil
}
