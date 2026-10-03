package microsandbox

import (
	"fmt"
	"math"
	"os/exec"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// ReserveBytes and machine memory are uncalibrated default (see #3659).
// Disk constants are the shared runtime contract from spec §8.2.1.
const (
	ReserveBytes            int64 = 8 << 30
	MachineMemoryBytes      int64 = 8 << 30
	SmallMachineMemoryBytes int64 = 6 << 30
	MachineDiskBytes        int64 = 32 << 30
	MinFreeDiskBytes        int64 = 40 << 30
)

type HostProfile struct {
	MemoryBytes   int64  `json:"memory_bytes"`
	PerfCores     int    `json:"perf_cores"`
	PhysicalCores int    `json:"physical_cores"`
	DiskFreeBytes int64  `json:"disk_free_bytes"`
	MacOSVersion  string `json:"macos_version"`
	Hypervisor    bool   `json:"hypervisor"`
}

type HostProfileError struct {
	Field string
	Cause error
}

func (e *HostProfileError) Error() string {
	return fmt.Sprintf("host profile %s: %v", e.Field, e.Cause)
}
func (e *HostProfileError) Unwrap() error            { return e.Cause }
func (*HostProfileError) FlowRuntimeCode() string    { return "host_profile_unavailable" }
func (*HostProfileError) FlowRuntimeClass() string   { return "infra" }
func (*HostProfileError) FlowRuntimeRetryable() bool { return false }

// Detect measures the state volume, never the executable's or current directory's volume.
func Detect(state string) (HostProfile, error) {
	return detectProfile(state, runtime.GOOS, func(key string) (string, error) {
		var command *exec.Cmd
		if key == "macos" {
			command = exec.Command("/usr/bin/sw_vers", "-productVersion")
		} else {
			command = exec.Command("/usr/sbin/sysctl", "-n", key)
		}
		out, err := command.Output()
		return strings.TrimSpace(string(out)), err
	}, func(path string) (int64, error) {
		var stat unix.Statfs_t
		if err := unix.Statfs(path, &stat); err != nil {
			return 0, err
		}
		return int64(stat.Bavail) * int64(stat.Bsize), nil
	})
}

func detectProfile(state, goos string, probe func(string) (string, error), disk func(string) (int64, error)) (HostProfile, error) {
	fail := func(field string, err error) (HostProfile, error) {
		return HostProfile{}, &HostProfileError{Field: field, Cause: err}
	}
	if goos != "darwin" {
		return fail("platform", fmt.Errorf("macOS is required"))
	}
	var p HostProfile
	for _, field := range []string{"hw.memsize", "hw.perflevel0.physicalcpu", "hw.physicalcpu", "macos", "kern.hv_support"} {
		value, err := probe(field)
		if err != nil {
			return fail(field, err)
		}
		if field == "macos" {
			if value == "" {
				return fail(field, fmt.Errorf("empty version"))
			}
			p.MacOSVersion = value
			continue
		}
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 0 || n == 0 && field != "kern.hv_support" {
			return fail(field, fmt.Errorf("invalid value %q", value))
		}
		switch field {
		case "hw.memsize":
			p.MemoryBytes = n
		case "hw.perflevel0.physicalcpu":
			p.PerfCores = int(n)
		case "hw.physicalcpu":
			p.PhysicalCores = int(n)
		case "kern.hv_support":
			p.Hypervisor = n == 1
		}
	}
	free, err := disk(state)
	if err != nil {
		return fail("disk", err)
	}
	if free < 0 {
		return fail("disk", fmt.Errorf("negative free bytes"))
	}
	p.DiskFreeBytes = free
	return p, nil
}

type Sizing struct {
	MemoryMiB        int    `json:"memory_mib"`
	CPUs             int    `json:"cpus"`
	Capacity         int    `json:"capacity"`
	LayerBudgetBytes int64  `json:"layer_budget_bytes"`
	MemoryCapacity   int    `json:"memory_capacity"`
	CoreCapacity     int    `json:"core_capacity"`
	DiskCapacity     int    `json:"disk_capacity"`
	LimitingTerm     string `json:"limiting_term"`
	Missing          int64  `json:"missing,omitempty"` // Bytes for memory/disk, cores for cores.
	Fix              string `json:"fix,omitempty"`
}

// ComputeSizing is pure. Go cannot name a function and a type both Sizing.
func ComputeSizing(p HostProfile) Sizing {
	memory := MachineMemoryBytes
	if p.MemoryBytes < 24<<30 {
		memory = SmallMachineMemoryBytes
	}
	s := Sizing{MemoryMiB: int(memory >> 20), CPUs: min(4, max(2, p.PerfCores/2)),
		MemoryCapacity: int(max(0, p.MemoryBytes-ReserveBytes) / memory), CoreCapacity: max(0, p.PerfCores/2),
		DiskCapacity: int(max(0, p.DiskFreeBytes-MinFreeDiskBytes) / MachineDiskBytes), LayerBudgetBytes: min(48<<30, max(0, p.DiskFreeBytes)/4)}
	s.Capacity = min(s.MemoryCapacity, s.CoreCapacity, s.DiskCapacity)
	s.LimitingTerm = "memory"
	if s.CoreCapacity < s.MemoryCapacity {
		s.LimitingTerm = "cores"
	}
	if s.DiskCapacity < min(s.CoreCapacity, s.MemoryCapacity) {
		s.LimitingTerm = "disk"
	}
	if s.Capacity == 0 {
		switch s.LimitingTerm {
		case "memory":
			s.Missing = max(0, ReserveBytes+memory-p.MemoryBytes)
			s.Fix = fmt.Sprintf("needs %d GiB of memory", (ReserveBytes+memory)>>30)
		case "cores":
			s.Missing = int64(max(0, 2-p.PerfCores))
			s.Fix = "needs 2 performance cores"
		case "disk":
			s.Missing = max(0, MinFreeDiskBytes+MachineDiskBytes-p.DiskFreeBytes)
			s.Fix = fmt.Sprintf("free %.0f GiB on the state volume", math.Ceil(float64(s.Missing)/(1<<30)))
		}
	}
	return s
}

type CapacityError struct {
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"`
	Missing int64  `json:"missing,omitempty"`
}

func (e *CapacityError) Error() string { return e.Message }

func (s Sizing) ValidateStart(hasOwner bool) error {
	if s.Capacity == 0 && !hasOwner {
		amount := fmt.Sprintf("%.2f GiB missing (%d bytes)", float64(s.Missing)/(1<<30), s.Missing)
		if s.LimitingTerm == "cores" {
			amount = fmt.Sprintf("%d performance cores missing", s.Missing)
		}
		return &CapacityError{Code: "host_capacity_zero", Class: "capacity", Message: "cannot start a fresh install: " + s.LimitingTerm + ": " + s.Fix + "; " + amount, Fix: s.Fix, Missing: s.Missing}
	}
	return nil
}

// Clamp is used on every persisted read, including after restoring onto a smaller host.
func Clamp(owner, formula int) (int, error) {
	if owner <= 0 {
		return 0, &CapacityError{Code: "invalid_capacity", Class: "user", Message: "capacity must be positive"}
	}
	if formula < 0 {
		return 0, &CapacityError{Code: "invalid_host_capacity", Class: "infra", Message: "host capacity cannot be negative"}
	}
	return min(owner, formula), nil
}
