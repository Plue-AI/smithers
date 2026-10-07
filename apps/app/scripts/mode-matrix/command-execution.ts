export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandExecutor = (args: readonly string[]) => Promise<CommandResult>

export const executeCommand = async (args: readonly string[], cwd = process.cwd()): Promise<CommandResult> => {
  const child = Bun.spawn([...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return { exitCode, stdout, stderr }
}
