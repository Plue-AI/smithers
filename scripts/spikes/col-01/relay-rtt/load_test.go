package main

import "testing"

func TestParseLoadavgReadsSysctlFormat(t *testing.T) {
	load, err := parseLoadavg("{ 9.84 20.03 23.50 }\n")
	if err != nil || load != [3]float64{9.84, 20.03, 23.50} {
		t.Fatalf("got %v, %v", load, err)
	}
}

func TestParseLoadavgRejectsFailedCommand(t *testing.T) {
	// command() returns this text when sysctl fails; the gate must not read it as idle.
	if _, err := parseLoadavg("command failed: exit status 1"); err == nil {
		t.Fatal("expected an error")
	}
}
