import { endpoint, type Settings } from "./provider"
import { type Frame, Journal } from "./store"
export function mount() {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const status = el("run-status"),
    slider = el<HTMLInputElement>("checkpoint"),
    branches = el<HTMLSelectElement>("branch-select")
  let journal: Journal
  try {
    journal = new Journal(localStorage)
  } catch (error) {
    status.textContent = String(error)
    return
  }
  let settings: Settings = { baseUrl: "", model: "", apiKey: "" },
    controller: AbortController | undefined,
    selected = journal.branch.frames.length - 1,
    launchError = ""
  const render = () => {
    slider.max = String(journal.branch.frames.length - 1)
    slider.value = String(selected)
    el("position").textContent = `${selected} / ${slider.max}`
    const frame: Frame = journal.branch.frames[selected]!
    el("file-content").textContent = frame.files["math.js"] ?? ""
    const transcript = el("transcript")
    transcript.replaceChildren()
    for (const event of frame.events) {
      if (event.kind === "flow") {
        const row = document.createElement("details"),
          summary = document.createElement("summary"),
          detail = document.createElement("pre")
        const [label, ...body] = event.text.split("\n")
        summary.textContent = label!
        detail.textContent = body.join("\n")
        row.append(summary, detail)
        transcript.append(row)
      } else {
        const row = document.createElement("pre")
        row.className = event.kind
        row.textContent = event.text
        transcript.append(row)
      }
    }
    if (selected === journal.branch.frames.length - 1) transcript.scrollTop = transcript.scrollHeight
    branches.replaceChildren(...journal.state.branches.map((branch) => {
      const option = document.createElement("option")
      option.value = branch.id
      option.textContent = branch.title
      option.selected = journal.state.current === branch.id
      return option
    }))
    const running = controller !== undefined
    el<HTMLButtonElement>("run").disabled = running || selected !== journal.branch.frames.length - 1 ||
      ["requested", "running"].includes(journal.head.run?.status ?? "")
    el("stop").hidden = !running
    el("resume").hidden = running || !journal.head.run || journal.head.run.status === "done"
    el<HTMLButtonElement>("branch").disabled = running
    branches.disabled = running
    const run = frame.run
    status.textContent = launchError || run?.error || run?.status || ""
  }
  const changed = () => {
    selected = journal.branch.frames.length - 1
    render()
  }
  const launch = (prompt?: string) => {
    if (controller) return
    launchError = ""
    controller = new AbortController()
    const signal = controller.signal
    render()
    void navigator.locks.request("smithers-tui-playground", { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("The sandbox is running in another tab.")
      journal = new Journal(localStorage)
      if (prompt !== undefined) journal.start(prompt, crypto.randomUUID())
      changed()
      const { run } = await import("./agent")
      await run(journal, settings, changed, signal)
    }).catch((error) => {
      launchError = error instanceof Error ? error.message : String(error)
    }).finally(() => {
      controller = undefined
      render()
    })
  }
  el<HTMLFormElement>("prompt-form").onsubmit = (event) => {
    event.preventDefault()
    if (controller) return
    const prompt = el<HTMLTextAreaElement>("prompt").value.trim()
    if (!prompt || prompt.length > 4000) {
      status.textContent = "Enter a task under 4,000 characters."
      return
    }
    launch(prompt)
  }
  el("resume").onclick = () => launch()
  el("stop").onclick = () => controller?.abort()
  slider.oninput = () => {
    selected = Number(slider.value)
    render()
  }
  const mutate = (action: () => void) => {
    void navigator.locks.request("smithers-tui-playground", { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("The sandbox is running in another tab.")
      const previous = JSON.stringify(journal.state)
      journal = new Journal(localStorage)
      if (JSON.stringify(journal.state) !== previous) {
        changed()
        throw new Error("The sandbox changed in another tab. Select a checkpoint again.")
      }
      action()
      launchError = ""
      changed()
    }).catch((error) => {
      launchError = String(error)
      render()
    })
  }
  el("branch").onclick = () => mutate(() => journal.branchAt(selected, crypto.randomUUID()))
  branches.onchange = () => {
    const id = branches.value
    mutate(() => journal.select(id))
  }
  el("settings-open").onclick = () => el<HTMLDialogElement>("settings").showModal()
  el("settings-close").onclick = () => el<HTMLDialogElement>("settings").close()
  el<HTMLFormElement>("settings-form").onsubmit = (event) => {
    event.preventDefault()
    const next = {
      baseUrl: el<HTMLInputElement>("base-url").value.trim(),
      model: el<HTMLInputElement>("model").value.trim(),
      apiKey: el<HTMLInputElement>("api-key").value
    }
    try {
      if (next.baseUrl) {
        endpoint(next.baseUrl)
        if (!next.model) throw new Error("Enter a model.")
      }
      settings = next
      el<HTMLDialogElement>("settings").close()
    } catch (error) {
      status.textContent = String(error)
    }
  }
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith("smithers.tui.playground") && !controller) {
      journal = new Journal(localStorage)
      changed()
    }
  })
  render()
}
