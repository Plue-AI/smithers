/** Disposable T-COL-01 measurements and local behavioral checks. */
import { Smithers } from "@smthrs/targets"

const data = [Smithers.glob("//scripts/spikes/col-01/**"), Smithers.glob("//packages/backend/**/*.go"), Smithers.file("//go.mod"), Smithers.file("//go.sum")]
export const Package = Smithers.Package({
  targets: {
    test: Smithers.Shell.Test({
      shell: "bash scripts/spikes/col-01/test.sh",
      data,
      timeout: "20m",
      exclusive: true,
      hosts: ["darwin", "linux"]
    }),
    rtt: Smithers.Shell.Test({
      shell: "bash scripts/spikes/col-01/run.sh rtt",
      data,
      timeout: "3h",
      exclusive: true,
      hosts: ["darwin"]
    }),
    keystrokes: Smithers.Shell.Test({
      shell: "bash scripts/spikes/col-01/run.sh keystrokes",
      data,
      timeout: "3h",
      exclusive: true,
      hosts: ["darwin"]
    }),
    snapshot: Smithers.Shell.Test({
      shell: "bash scripts/spikes/col-01/run.sh snapshot",
      data,
      timeout: "3h",
      exclusive: true,
      hosts: ["darwin"]
    })
  }
})
