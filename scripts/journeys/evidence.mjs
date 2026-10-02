const utc = (value, name) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`Invalid UTC ${name}`)
  return Date.parse(value)
}

export function verifyActivation({ t0, clockOffsetStartMs, clockOffsetEndMs }, pull) {
  for (const offset of [clockOffsetStartMs, clockOffsetEndMs]) if (!Number.isFinite(offset)) throw new Error("Activation requires both recorded clock offsets")
  const start = utc(t0, "T0") - clockOffsetStartMs
  if (pull?.merged !== true || !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha ?? "") || !pull.merged_at || pull.base?.ref !== "main" || !/^smithers\/[a-zA-Z0-9_-]+$/.test(pull.head?.ref ?? "")) throw new Error("Activation requires GitHub's completed TODO merge receipt")
  const elapsedMs = utc(pull.merged_at, "GitHub merged_at") - start
  if (elapsedMs < 0 || elapsedMs > 60 * 60_000) throw new Error(`Activation exceeded 60 minutes or has invalid ordering: ${elapsedMs} ms`)
  return { t0, mergedAt: pull.merged_at, elapsedMs, clockOffsetStartMs, clockOffsetEndMs, mergeCommit: pull.merge_commit_sha }
}

export function verifyCredentialSoak(receipt, { commit, installVersion } = {}) {
  const start = utc(receipt?.startedAt, "soak start")
  const end = utc(receipt?.finishedAt, "soak end")
  if (end - start < 24 * 60 * 60_000) throw new Error("Credential soak must span 24 hours")
  if (commit && receipt.commit !== commit || installVersion && receipt.installVersion !== installVersion) throw new Error("Credential soak must use the recorded install release")
  const machines = receipt.machines
  if (!Array.isArray(machines) || machines.length !== 2 || machines[0] === machines[1]) throw new Error("Credential soak needs two distinct machines")
  if (!Array.isArray(receipt.calls) || !Array.isArray(receipt.wakes) || !Array.isArray(receipt.credentialChanges)) throw new Error("Credential soak needs call, wake and credential_changed logs")
  const tools = ["claude", "codex", "gh"]
  const seen = new Set()
  for (const call of receipt.calls) {
    if (!machines.includes(call.machine) || !tools.includes(call.tool) || !Number.isSafeInteger(call.cycle) || call.cycle < 0 || call.cycle > 144 || call.exitCode !== 0 || call.loginPrompt !== false) throw new Error("Credential soak call failed or requested login")
    const key = `${call.machine}/${call.tool}/${call.cycle}`
    if (seen.has(key)) throw new Error("Duplicate credential soak call")
    seen.add(key)
    const time = utc(call.timestamp, "call")
    const scheduled = start + call.cycle * 10 * 60_000
    if (time < scheduled || time - scheduled > 60_000 || time > end) throw new Error("Credential soak call missed its 10 minute schedule")
  }
  for (const machine of machines) for (const tool of tools) for (let cycle = 0; cycle <= 144; cycle++) if (!seen.has(`${machine}/${tool}/${cycle}`)) throw new Error("Credential soak has a missing tool call")
  for (let cycle = 24; cycle <= 144; cycle += 24) {
    const wake = receipt.wakes.find((item) => item.machine === machines[1] && item.cycle === cycle)
    if (!wake || wake.firstCallSucceeded !== true || utc(wake.sleptAt, "sleep") >= utc(wake.wokeAt, "wake")) throw new Error("Credential soak needs B sleep/wake every four hours with a successful first call")
    const nextCall = receipt.calls.filter((call) => call.machine === machines[1] && call.cycle === cycle)
    if (nextCall.some((call) => utc(call.timestamp, "post-wake call") < Date.parse(wake.wokeAt))) throw new Error("Credential soak called a tool before B woke")
  }
  for (const change of receipt.credentialChanges) {
    if (!machines.includes(change.machine) || !machines.includes(change.receivedMachine) || change.machine === change.receivedMachine) throw new Error("Invalid credential_changed delivery machines")
    const written = utc(change.written_at, "credential write")
    const received = utc(change.receivedAt, "credential receipt")
    const next = receipt.calls.filter((call) => call.machine === change.receivedMachine && Date.parse(call.timestamp) > written).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0]
    if (written < start || written > end || received < written || !next || received >= Date.parse(next.timestamp)) throw new Error("credential_changed failed to reach the other machine before its next call")
  }
  return { startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, calls: receipt.calls.length, credentialChanges: receipt.credentialChanges.length, machines }
}
