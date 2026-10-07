package wire

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestWireCorpus(t *testing.T) {
	const root = "../../compose/testdata/cocontracts/"
	manifest, e := os.ReadFile(root + "MANIFEST.json")
	if e != nil {
		t.Fatal(e)
	}
	var m struct {
		Protocol uint16
		Frames   []struct {
			Name, Expected, SHA256, Vector, Handshake string
			Local                                     bool
		}
		Vectors map[string]struct {
			Secret, Nonce string
			BootID        string `json:"boot_id"`
		} `json:"handshake_vectors"`
	}
	if e = json.Unmarshal(manifest, &m); e != nil {
		t.Fatal(e)
	}
	if m.Protocol != Protocol {
		t.Fatalf("MANIFEST protocol %d, codec %d", m.Protocol, Protocol)
	}
	for _, tc := range m.Frames {
		t.Run(tc.Name, func(t *testing.T) {
			b, e := os.ReadFile(root + tc.Name + ".bin")
			if e != nil {
				t.Fatal(e)
			}
			if fmt.Sprintf("%x", sha256.Sum256(b)) != tc.SHA256 {
				t.Fatal("fixture corruption")
			}
			var f Frame
			if tc.Local {
				f, e = DecodeLocal(b)
			} else {
				f, e = Decode(b)
			}
			// A current-protocol HostProof answering a committed challenge: the
			// production verifier accepts exactly the vector's mac. Version
			// refusals are proven by MANIFEST refusal_sequences instead.
			if tc.Vector != "" && e == nil && f.Payload[0] == 2 && tc.Handshake != "version_mismatch" {
				v := m.Vectors[tc.Vector]
				fields, err := Fields("proof", f.Payload[1:])
				secret, _ := hex.DecodeString(v.Secret)
				boot, _ := hex.DecodeString(v.BootID)
				nonce, _ := hex.DecodeString(v.Nonce)
				if err != nil || len(secret) != 32 || len(boot) != 16 || len(nonce) != 32 {
					t.Fatal("vector", tc.Vector, err)
				}
				if ok := VerifyHostMAC(secret, Protocol, boot, nonce, fields[2]); ok != (tc.Handshake == "") {
					t.Fatalf("proof verified %t, handshake %q", ok, tc.Handshake)
				}
			}
			if tc.Expected != "ok" {
				if e == nil || e.Error() != tc.Expected {
					t.Fatalf("got %v want %s", e, tc.Expected)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			j, e := os.ReadFile(root + tc.Name + ".json")
			if e != nil {
				t.Fatal(e)
			}
			var literal struct {
				Kind    byte
				Stream  uint32
				Payload string
			}
			if e = json.Unmarshal(j, &literal); e != nil {
				t.Fatal(e)
			}
			p, e := hex.DecodeString(literal.Payload)
			if e != nil {
				t.Fatal(e)
			}
			if f.Kind != literal.Kind || f.Stream != literal.Stream || !bytes.Equal(f.Payload, p) {
				t.Fatal("decoded literal")
			}
			f = Frame{Kind: literal.Kind, Stream: literal.Stream, Payload: p}
			var out []byte
			if tc.Local {
				out, e = EncodeLocal(f)
			} else {
				out, e = Encode(f)
			}
			if e != nil || !bytes.Equal(out, b) {
				t.Fatal("encoded literal", e)
			}
		})
	}
}
