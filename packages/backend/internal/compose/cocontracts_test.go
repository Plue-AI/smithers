package compose

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type wireManifest struct {
	Frames []struct {
		Name, Expected, SHA256 string
		Local                  bool
	}
	Sequences map[string][]string
}

func wireFixtures(t *testing.T) wireManifest {
	t.Helper()
	b, e := os.ReadFile("testdata/cocontracts/MANIFEST.json")
	if e != nil {
		t.Fatal(e)
	}
	var m wireManifest
	if e = json.Unmarshal(b, &m); e != nil {
		t.Fatal(e)
	}
	if len(m.Frames) < 100 {
		t.Fatal("missing daemon corpus")
	}
	return m
}
func wireBytes(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile("testdata/cocontracts/" + name + ".bin")
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestMachinedWireGoldenFrames(t *testing.T) {
	m := wireFixtures(t)
	for _, tc := range m.Frames {
		if tc.Expected != "ok" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			b := wireBytes(t, tc.Name)
			if fmt.Sprintf("%x", sha256.Sum256(b)) != tc.SHA256 {
				t.Fatal("fixture digest")
			}
			var f wire.Frame
			var e error
			if tc.Local {
				f, e = wire.DecodeLocal(b)
			} else {
				f, e = wire.Decode(b)
			}
			if e != nil {
				t.Fatal(e)
			}
			var value struct {
				Kind    byte
				Stream  uint32
				Payload string
			}
			j, e := os.ReadFile("testdata/cocontracts/" + tc.Name + ".json")
			if e != nil {
				t.Fatal(e)
			}
			if e = json.Unmarshal(j, &value); e != nil {
				t.Fatal(e)
			}
			literal, e := hex.DecodeString(value.Payload)
			if e != nil {
				t.Fatal(e)
			}
			if f.Kind != value.Kind || f.Stream != value.Stream || !bytes.Equal(f.Payload, literal) {
				t.Fatal("decoded value")
			}
			literalFrame := wire.Frame{Kind: value.Kind, Stream: value.Stream, Payload: literal}
			var got []byte
			if tc.Local {
				got, e = wire.EncodeLocal(literalFrame)
			} else {
				got, e = wire.Encode(literalFrame)
			}
			if e != nil || !bytes.Equal(got, b) {
				t.Fatal("encoded value", e)
			}

		})
	}
	for name, seq := range m.Sequences {
		t.Run(name, func(t *testing.T) {
			var b []byte
			for _, n := range seq {
				b = append(b, wireBytes(t, n)...)
			}
			r := bytes.NewReader(b)
			for _, n := range seq {
				f, e := wire.Read(r)
				if e != nil {
					t.Fatal(e)
				}
				out, e := wire.Encode(f)
				if e != nil || !bytes.Equal(out, wireBytes(t, n)) {
					t.Fatal(n, e)
				}
			}
			if r.Len() != 0 {
				t.Fatal("unread frames")
			}
		})
	}
}
func TestMachinedWireRefusals(t *testing.T) {
	for _, tc := range wireFixtures(t).Frames {
		if tc.Expected == "ok" {
			continue
		}
		t.Run(tc.Name, func(t *testing.T) {
			var e error
			if tc.Local {
				_, e = wire.DecodeLocal(wireBytes(t, tc.Name))
			} else {
				_, e = wire.Decode(wireBytes(t, tc.Name))
			}
			if e == nil || e.Error() != tc.Expected {
				t.Fatalf("got %v want %s", e, tc.Expected)
			}
		})
	}
	b := wireBytes(t, "req_write_file")
	for n := 0; n < len(b); n++ {
		if _, e := wire.Decode(b[:n]); e != wire.Truncated {
			t.Fatalf("cut %d: %v", n, e)
		}
	}
}
func TestWireContentLimit(t *testing.T) {
	if wire.MaxWorkspaceFileBytes != 1048576 {
		t.Fatal("changed content limit")
	}
	if _, e := wire.Decode(wireBytes(t, "content_at_limit")); e != nil {
		t.Fatal(e)
	}
	if _, e := wire.Decode(wireBytes(t, "content_over_limit")); e != wire.BadValue {
		t.Fatal(e)
	}
	if wire.InitialCredit != 262144 {
		t.Fatal("changed initial credit")
	}
}
func TestMachinedSkeletonDisabled(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Fatal("skeleton check requires an unprivileged runner")
	}
	root, e := filepath.Abs("../../../..")
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("cargo", "build", "--locked", "-p", "smithers-machined", "--bin", "smithers-machined")
	cmd.Dir = root
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("Rust build: %v\n%s", e, out)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	temp := t.TempDir()
	cmd = exec.Command(filepath.Join(root, "target/debug/smithers-machined"), "daemon")
	cmd.Dir = temp
	cmd.Env = append(os.Environ(), "SMITHERS_MACHINED_HOST="+listener.Addr().String())
	out, e := cmd.CombinedOutput()
	if e == nil {
		t.Fatal("skeleton started")
	}
	if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 78 {
		t.Fatal(e, string(out))
	}
	entries, e := os.ReadDir(temp)
	if e != nil || len(entries) != 0 {
		t.Fatal("hook side effect", e)
	}
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(25 * time.Millisecond))
	if _, e := listener.Accept(); e == nil {
		t.Fatal("unexpected connection")
	}
	cmd = exec.Command("cargo", "test", "--locked", "-p", "smithers-machined", "--test", "golden", "--test", "fake_host")
	cmd.Dir = root
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("Rust codec/dispatcher: %v\n%s", e, out)
	}
}
