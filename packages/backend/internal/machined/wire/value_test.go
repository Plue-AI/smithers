package wire

import (
	"encoding/json"
	"os"
	"testing"
)

func TestMessageCorpus(t *testing.T) {
	const root = "../../compose/testdata/cocontracts/"
	raw, err := os.ReadFile(root + "MANIFEST.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Frames []struct {
			Name, Expected string
			Local          bool
		}
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, entry := range manifest.Frames {
		if entry.Expected != "ok" || entry.Local {
			continue
		}
		t.Run(entry.Name, func(t *testing.T) {
			b, err := os.ReadFile(root + entry.Name + ".bin")
			if err != nil {
				t.Fatal(err)
			}
			frame, err := Decode(b)
			if err != nil {
				t.Fatal(err)
			}
			v, err := frame.Message()
			if frame.Kind > Presence {
				if err != BadValue {
					t.Fatal(err)
				}
				return
			}
			if err != nil || v.Variant == 0 {
				t.Fatalf("%+v %v", v, err)
			}
		})
	}
}
func TestMessageIndependentValues(t *testing.T) {
	load := func(name string) Value {
		t.Helper()
		b, err := os.ReadFile("../../compose/testdata/cocontracts/" + name + ".bin")
		if err != nil {
			t.Fatal(err)
		}
		f, err := Decode(b)
		if err != nil {
			t.Fatal(err)
		}
		v, err := f.Message()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	hello := load("hello_machine")
	if hello.Variant != 3 || string(hello.Fields[1].Data) != "boot-token" || hello.Fields[3].Number != 7 || len(hello.Fields[4].Items) != 1 || hello.Fields[4].Items[0].Number != 1 {
		t.Fatalf("%+v", hello)
	}
	write := load("req_write_file")
	if write.Variant != 1 || write.Fields[1].Number != 42 || write.Fields[2].Variant != 3 || string(write.Fields[2].Fields[1].Data) != "src/a.ts" {
		t.Fatalf("%+v", write)
	}
	captured := load("ev_captured")
	if captured.Variant != 1 || captured.Fields[1].Number != 8 || captured.Fields[3].Variant != 2 || len(captured.Fields[3].Fields[1].Data) != 20 {
		t.Fatalf("%+v", captured)
	}
	if _, err := (Frame{Kind: Control, Payload: []byte{1}}).Message(); err != Truncated {
		t.Fatal(err)
	}
}
