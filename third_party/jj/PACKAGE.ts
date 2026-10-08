import { Smithers } from "@smthrs/targets"

const sources = Smithers.Filegroup({ cwd: "third_party/jj", srcs: [Smithers.glob("**/*")] })

export const Package = Smithers.Package({ targets: { sources } })
