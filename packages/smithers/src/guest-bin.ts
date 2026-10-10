// A bundled process door over the existing install command mount.
import { Cli } from "incur"
import * as Presentation from "./cli/Presentation.ts"
import { mount } from "./internal/backend/Commands.ts"
import { packageVersion } from "./Version.ts"
const runtime = {
  environment: process.env,
  exit: (code: number) => {
    process.exitCode = code
  }
}
const cli = Cli.create("smthrs", { description: "Operate Smithers", version: packageVersion })
cli.use((context, next) => Presentation.scope(context, runtime, next))
mount(cli, runtime)
await Presentation.withErrorEnvelope((text) => {
  process.stdout.write(text)
}, (stdout) =>
  cli.serve(process.argv.slice(2), {
    env: process.env,
    stdout,
    exit: (code) => {
      process.exitCode = code
    }
  }))
