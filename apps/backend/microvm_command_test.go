package main

import (
	"reflect"
	"strings"
	"testing"
)

// `microvm gc` names every other install's state root to keep; anything else
// is a usage error, and doctor takes no argument.
func TestMicroVMCommand(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		command string
		roots   []string
	}{
		{args: []string{"doctor"}, command: "doctor"},
		{args: []string{"gc"}, command: "gc"},
		{args: []string{"gc", "--root", "/a/microvm", "--root", "/b/x/../microvm"}, command: "gc", roots: []string{"/a/microvm", "/b/microvm"}},
		{args: nil},
		{args: []string{"doctor", "extra"}},
		{args: []string{"gc", "--root"}},
		{args: []string{"gc", "--root", "relative/microvm"}},
		{args: []string{"gc", "--keep", "/a"}},
		{args: []string{"collect"}},
	} {
		command, roots, err := microVMCommand(tc.args)
		if tc.command == "" {
			if err == nil || !strings.Contains(err.Error(), "usage: smithers-backend microvm doctor | gc") {
				t.Errorf("%q: err = %v; want usage", tc.args, err)
			}
			continue
		}
		if err != nil || command != tc.command || !reflect.DeepEqual(roots, tc.roots) {
			t.Errorf("%q = %q %q %v; want %q %q", tc.args, command, roots, err, tc.command, tc.roots)
		}
	}
}
