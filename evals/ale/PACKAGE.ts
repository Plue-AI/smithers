import { Smithers } from "@smthrs/targets"

const offline = Smithers.Shell.Test({
  summary: "Reject incomplete ALE oracle and paired evidence; check adapter syntax without a model or task data.",
  script: Smithers.file("verify.sh"),
  data: [
    Smithers.glob("//evals/ale/**"),
    Smithers.file("//packages/smithers/src/internal/NativeEquipment.ts")
  ],
  timeout: "1m"
})

export const Package = Smithers.Package({ targets: { offline } })
