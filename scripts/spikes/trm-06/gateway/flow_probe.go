package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// All expectations below are literal fixtures independent of protocol/helper
// implementation constants. This driver runs against an already installed
// gateway; it supplies no direct supervisor socket or guest credential.
func runFlowProbe(ctx context.Context, root string, config installedConfig, hostKey ssh.PublicKey) (probeErr error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	private, err := readState(filepath.Join(root, "ben-fixture.key"), 65536)
	if err != nil {
		return err
	}
	signer, err := ssh.ParsePrivateKey(private)
	if err != nil {
		return err
	}
	expected, _, _, _, err := ssh.ParseAuthorizedKey([]byte(config.BenKey))
	if err != nil || !bytes.Equal(signer.PublicKey().Marshal(), expected.Marshal()) {
		return errAuthority
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", config.Listen)
	if err != nil {
		return err
	}
	connection.SetDeadline(time.Now().Add(10 * time.Second))
	clientConnection, channels, requests, err := ssh.NewClientConn(connection, config.Listen, &ssh.ClientConfig{User: "ben", Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)}, HostKeyCallback: ssh.FixedHostKey(hostKey)})
	if err != nil {
		connection.Close()
		return err
	}
	connection.SetDeadline(time.Time{})
	client := ssh.NewClient(clientConnection, channels, requests)
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()
	evidence := filepath.Join(root, "evidence", time.Now().UTC().Format("20060102T150405.000000000Z"))
	if err = os.MkdirAll(evidence, 0700); err != nil {
		return err
	}
	// Keep failed partial samples. A passing automatic subset is not C-SPK-08.
	result := map[string]any{"class": "supplemental", "reference_steps": []int{1, 2, 3, 4, 5, 9}, "vs_code_recording": false, "revocation_runs": 0, "restart_measured": false}
	defer func() {
		if probeErr != nil {
			result["failure"] = probeErr.Error()
		}
		body, _ := json.MarshalIndent(result, "", "  ")
		_ = os.WriteFile(filepath.Join(evidence, "result.json"), body, 0600)
	}()
	command := func(argv string, input []byte) ([]byte, error) {
		session, err := client.NewSession()
		if err != nil {
			return nil, err
		}
		defer session.Close()
		session.Stdin = bytes.NewReader(input)
		return session.CombinedOutput(argv)
	}
	_, err = command("exit 7", nil)
	var exit *ssh.ExitError
	if !errors.As(err, &exit) || exit.ExitStatus() != 7 {
		return errors.New("exit 7 fixture failed")
	}
	result["exit_status"] = exit.ExitStatus()
	_, err = command("kill -TERM $$", nil)
	if !errors.As(err, &exit) || exit.Signal() != "TERM" {
		return errors.New("TERM fixture failed")
	}
	result["exit_signal"] = exit.Signal()
	fixture := make([]byte, 1048576)
	for i := range fixture {
		fixture[i] = byte(i % 256)
	}
	if err = os.WriteFile(filepath.Join(evidence, "onemib.bin"), fixture, 0600); err != nil {
		return err
	}
	output, err := command("wc -c", fixture)
	if err != nil || strings.TrimSpace(string(output)) != "1048576" {
		return errors.New("stdin half-close byte count failed")
	}
	output, err = command("cat", fixture)
	if err != nil || !bytes.Equal(output, fixture) {
		return errors.New("binary roundtrip fixture failed")
	}
	digest := sha256.Sum256(output)
	result["onemib_sha256"] = hex.EncodeToString(digest[:])
	if err = os.WriteFile(filepath.Join(evidence, "onemib.received.bin"), output, 0600); err != nil {
		return err
	}
	if err = flowControlFixture(client, evidence, result); err != nil {
		result["failure"] = err.Error()
		return err
	}
	if err = ptyFixture(client, evidence, result); err != nil {
		result["failure"] = err.Error()
		return err
	}
	if err = forwardFixture(client, evidence); err != nil {
		result["failure"] = err.Error()
		return err
	}
	if err = relaySequenceFixture(ctx, client, root, evidence); err != nil {
		result["failure"] = err.Error()
		return err
	}
	for _, mode := range []string{"lost-window", "delivered-eof"} {
		if err = relayInputFixture(ctx, client, root, evidence, mode); err != nil {
			return err
		}
	}
	result["automatic_subset_passed"] = true
	fmt.Printf("{\"automatic_subset_passed\":true,\"evidence\":%q,\"C-SPK-08\":\"pending\"}\n", evidence)
	return nil
}

// Independent kernel samples are collected by a Ben session, not by the
// supervisor's own counters. They select root's fixed --serve argv, and retain
// raw RSS values rather than infer memory from the credit setting.
const rssObserver = `python3 -u -c 'import os,time
for i in range(1800):
 rows=[]
 for p in os.listdir("/proc"):
  if not p.isdecimal(): continue
  try:
   argv=open("/proc/"+p+"/cmdline","rb").read().split(b"\0")
   if argv[:2]!=[b"/opt/smithers/prototype/supervisor",b"--serve"]: continue
   status=dict(line.split(":",1) for line in open("/proc/"+p+"/status") if ":" in line)
   if status["Uid"].split()!=["0"]*4: continue
   rows.append((p,int(status["VmRSS"].split()[0])*1024))
  except (FileNotFoundError,ProcessLookupError,PermissionError,KeyError): pass
 for p,rss in rows: print(str(time.monotonic_ns())+","+p+","+str(rss),flush=True)
 time.sleep(.1)
'`

func flowControlFixture(client *ssh.Client, evidence string, result map[string]any) error {
	observer, err := client.NewSession()
	if err != nil {
		return err
	}
	defer observer.Close()
	samples, err := observer.StdoutPipe()
	if err != nil {
		return err
	}
	if err = observer.Start(rssObserver); err != nil {
		return err
	}
	raw, err := os.OpenFile(filepath.Join(evidence, "rss.csv"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer raw.Close()
	var mu sync.Mutex
	var baseline, peak int64
	var sampleCount int
	sampleDone := make(chan error, 1)
	first := make(chan struct{}, 1)
	go func() {
		scanner := bufio.NewScanner(samples)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(raw, line)
			fields := strings.Split(line, ",")
			if len(fields) != 3 {
				sampleDone <- errors.New("malformed independent RSS sample")
				return
			}
			rss, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil {
				sampleDone <- err
				return
			}
			mu.Lock()
			if sampleCount == 0 {
				baseline = rss
				first <- struct{}{}
			}
			if rss > peak {
				peak = rss
			}
			sampleCount++
			mu.Unlock()
		}
		sampleDone <- scanner.Err()
	}()
	select {
	case <-first:
	case err := <-sampleDone:
		if err != nil {
			return err
		}
		return errors.New("no independent supervisor RSS sample")
	case <-time.After(3 * time.Second):
		return errors.New("independent RSS observer unavailable")
	}
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	output, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err = session.Start("head -c 1073741824 /dev/zero"); err != nil {
		return err
	}
	// Do not consume stdout for ten seconds. This stalls the actual SSH window
	// and therefore the guest's real relay credit, not a synthetic memory pipe.
	time.Sleep(10 * time.Second)
	n, err := io.Copy(io.Discard, output)
	if err != nil {
		return err
	}
	if err = session.Wait(); err != nil {
		return err
	}
	if n != 1073741824 {
		return fmt.Errorf("one GiB fixture lost bytes: %d", n)
	}
	_ = observer.Signal(ssh.SIGTERM)
	_ = observer.Wait()
	select {
	case err := <-sampleDone:
		if err != nil {
			return err
		}
	case <-time.After(time.Second):
		return errors.New("RSS observer did not terminate")
	}
	mu.Lock()
	defer mu.Unlock()
	result["received_bytes"] = n
	result["rss_baseline_bytes"] = baseline
	result["rss_peak_bytes"] = peak
	result["rss_samples"] = sampleCount
	if peak-baseline >= 16777216 {
		return fmt.Errorf("RSS growth exceeded fixture: %d", peak-baseline)
	}
	return nil
}
func ptyFixture(client *ssh.Client, evidence string, result map[string]any) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	if err = session.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err != nil {
		return err
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return err
	}
	output, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err = session.Start("stty size; read token; stty size; sleep 100"); err != nil {
		return err
	}
	lines := make(chan string, 16)
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			lines <- strings.TrimSpace(scanner.Text())
		}
		close(lines)
	}()
	expect := func(want string) error {
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					return io.ErrUnexpectedEOF
				}
				if line == want {
					return nil
				}
			case <-timer.C:
				return fmt.Errorf("PTY fixture missing %s", want)
			}
		}
	}
	if err = expect("24 80"); err != nil {
		return err
	}
	if err = session.WindowChange(40, 120); err != nil {
		return err
	}
	if _, err = stdin.Write([]byte("\n")); err != nil {
		return err
	}
	if err = expect("40 120"); err != nil {
		return err
	}
	_ = os.WriteFile(filepath.Join(evidence, "pty.txt"), []byte("24 80\n40 120\n"), 0600)
	started := time.Now()
	if _, err = stdin.Write([]byte{3}); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- session.Wait() }()
	select {
	case <-done:
		result["ctrl_c_ms"] = time.Since(started).Milliseconds()
		if time.Since(started) > time.Second {
			return errors.New("Ctrl-C exceeded one second")
		}
	case <-time.After(time.Second):
		return errors.New("Ctrl-C did not terminate sleep")
	}
	return nil
}
func forwardFixture(client *ssh.Client, evidence string) error {
	if accepted, _, err := client.SendRequest("tcpip-forward", true, ssh.Marshal(struct {
		Host string
		Port uint32
	}{"127.0.0.1", 3000})); err != nil || accepted {
		return errors.New("remote forwarding was not refused")
	}
	channel, err := client.NewSession()
	if err != nil {
		return err
	}
	defer channel.Close()
	if accepted, err := channel.SendRequest("auth-agent-req@openssh.com", true, nil); err != nil || accepted {
		return errors.New("agent forwarding was not refused")
	}
	if stream, err := client.Dial("tcp", "192.0.2.1:80"); err == nil {
		stream.Close()
		return errors.New("non-loopback TCP was accepted")
	}
	if err = channel.Start("python3 -m http.server 3000 --bind 127.0.0.1 --directory /workspace"); err != nil {
		return err
	}
	defer channel.Signal(ssh.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	var stream net.Conn
	for {
		stream, err = client.Dial("tcp", "127.0.0.1:3000")
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer stream.Close()
	stream.SetDeadline(time.Now().Add(3 * time.Second))
	if err = writeAll(stream, []byte("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")); err != nil {
		return err
	}
	response, err := io.ReadAll(io.LimitReader(stream, 1048576))
	_ = os.WriteFile(filepath.Join(evidence, "forward.http"), response, 0600)
	if err != nil || !bytes.Contains(response, []byte("Directory listing for /")) {
		return errors.New("real loopback forwarding fixture failed")
	}
	return nil
}
func relaySequenceFixture(ctx context.Context, client *ssh.Client, root, evidence string) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	pipe, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err = session.Start("seq 1 100000 | while IFS= read -r line; do printf '%s\\n' \"$line\"; done"); err != nil {
		return err
	}
	reader := bufio.NewReader(pipe)
	first, err := reader.ReadString('\n')
	if err != nil || first != "1\n" {
		return errors.New("sequence fixture did not start")
	}
	cutStarted := time.Now()
	control, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, "control.sock"))
	if err != nil {
		return err
	}
	control.SetDeadline(time.Now().Add(2 * time.Second))
	if err = writeAll(control, []byte("cut-relay\n")); err != nil {
		control.Close()
		return err
	}
	var reply [4]byte
	_, err = io.ReadFull(control, reply[:])
	control.Close()
	if err != nil || string(reply[:]) != "cut\n" {
		return errors.New("real relay cut was not acknowledged")
	}
	file, err := os.OpenFile(filepath.Join(evidence, "seq.txt"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	fmt.Fprint(file, first)
	// Continue the SSH connection. Only its actual guest relay is cut; the
	// installed adapter must reattach and replay while retaining sequence order.
	scanner := bufio.NewScanner(reader)
	expected := 2
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Fprintln(file, line)
		if line != strconv.Itoa(expected) {
			return fmt.Errorf("sequence order failed at %d", expected)
		}
		expected++
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	if err = session.Wait(); err != nil {
		return err
	}
	elapsed := time.Since(cutStarted)
	faultReceipt, _ := json.Marshal(map[string]any{"invoked_utc": cutStarted.UTC().Format(time.RFC3339Nano), "completion_ms": elapsed.Milliseconds(), "lines": expected - 1})
	_ = os.WriteFile(filepath.Join(evidence, "relay-cut.json"), faultReceipt, 0600)
	if elapsed < 10*time.Second {
		return errors.New("sequence completed before the ten-second relay cut; no reconnect evidence")
	}
	if expected != 100001 {
		return fmt.Errorf("sequence lost lines: %d", expected-1)
	}
	return nil
}

func relayInputFixture(ctx context.Context, client *ssh.Client, root, evidence, mode string) error {
	control, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(root, "control.sock"))
	if err != nil {
		return err
	}
	control.SetDeadline(time.Now().Add(2 * time.Second))
	if err = writeAll(control, []byte(mode+"\n")); err != nil {
		control.Close()
		return err
	}
	var ack [6]byte
	_, err = io.ReadFull(control, ack[:])
	control.Close()
	if err != nil || string(ack[:]) != "armed\n" {
		return errors.New("relay input fault was not armed")
	}
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	fixture := make([]byte, 1048576)
	for i := range fixture {
		fixture[i] = byte(i % 251)
	}
	session.Stdin = bytes.NewReader(fixture)
	started := time.Now()
	output, err := session.Output("cat")
	receipt := map[string]any{"fault": mode, "invoked_utc": started.UTC().Format(time.RFC3339Nano), "completion_ms": time.Since(started).Milliseconds(), "expected_bytes": 1048576, "received_bytes": len(output), "exact_match": bytes.Equal(output, fixture)}
	if err != nil {
		receipt["failure"] = err.Error()
	}
	body, _ := json.MarshalIndent(receipt, "", "  ")
	if saveErr := os.WriteFile(filepath.Join(evidence, mode+".json"), body, 0600); saveErr != nil {
		return saveErr
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(output, fixture) {
		return fmt.Errorf("%s lost or duplicated stdin bytes", mode)
	}
	return os.WriteFile(filepath.Join(evidence, mode+".bin"), output, 0600)
}
