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
		Frames []struct {
			Name, Expected, SHA256 string
			Local                  bool
		}
	}
	if e = json.Unmarshal(manifest, &m); e != nil {
		t.Fatal(e)
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
