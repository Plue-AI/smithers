import { Smithers } from "@smthrs/targets"

// T-MCH-02: the existing Python suites had no declared target. Keep their
// ownership beside the harness; no second test runner or VM harness is added.
const test = Smithers.Shell.Test({
  shell: "python3 -B scripts/spikes/mch-02-virtiofs-homes/test-verdict.py && python3 -B scripts/spikes/mch-02-virtiofs-homes/test-concurrent.py",
  data: [Smithers.glob("//scripts/spikes/mch-02-virtiofs-homes/*")],
  timeout: "2m"
})

export const Package = Smithers.Package({ targets: { test } })
