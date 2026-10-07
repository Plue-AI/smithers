package wire

import "encoding/hex"

// Reconciled names the previous acknowledged head and the host's wake target.
// Onto is not the resulting working-copy snapshot; only a later capture names it.
type Reconciled struct {
	Old, Onto string
	Conflict  bool
	Paths     []string
}

func DecodeReconciled(payload []byte) (Reconciled, error) {
	c := cursor{payload}
	if err := c.value("event"); err != nil {
		return Reconciled{}, err
	}
	if len(c.b) != 0 {
		return Reconciled{}, TrailingBytes
	}
	if payload[0] != 3 {
		return Reconciled{}, UnknownMessage
	}
	f := fields(payload[1:], "reconciled")
	r := Reconciled{Old: hex.EncodeToString(f[1]), Onto: hex.EncodeToString(f[2]), Conflict: f[3][0] == 2}
	if r.Old == r.Onto || r.Old == "0000000000000000000000000000000000000000" || r.Onto == "0000000000000000000000000000000000000000" {
		return Reconciled{}, BadValue
	}
	if raw, ok := f[4]; ok {
		list := cursor{raw}
		n, _ := list.number(2)
		for range n {
			start := list.b
			_ = list.value("str")
			r.Paths = append(r.Paths, textValue(start[:len(start)-len(list.b)]))
		}
	}
	if r.Conflict != (len(r.Paths) > 0) {
		return Reconciled{}, BadValue
	}
	return r, nil
}
