// This installed code reads JSON data only. No repository path becomes an import.
import { readFileSync } from "node:fs"
import { evidence, MachineRecipeError, memoryRepository } from "../src/suggest/Checklist.ts"
try {
  const files = JSON.parse(readFileSync(0, "utf8")) as Record<string, string>
  const recipe = evidence(memoryRepository("/mirror", files)).machine
  if (recipe instanceof MachineRecipeError) throw recipe
  process.stdout.write(JSON.stringify({ recipe }))
} catch (error) {
  if (!(error instanceof MachineRecipeError)) throw error
  process.stdout.write(
    JSON.stringify({ error: { code: error.code, class: error.class, message: error.message, fix: error.fix } })
  )
}
