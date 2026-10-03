// The calibration uses the production detector and limits, never a copied formula.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: profile STATE")
		os.Exit(1)
	}
	p, err := microsandbox.Detect(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	err = json.NewEncoder(os.Stdout).Encode(map[string]any{"image": microsandbox.DefaultImage, "profile": p, "limits": microsandbox.ComputeSizing(p), "reserve_bytes": microsandbox.ReserveBytes, "disk_bytes": microsandbox.MachineDiskBytes})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
