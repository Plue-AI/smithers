// The signup form. Bug #7: on Safari the <button> sits inside an <a>, so the click is swallowed.
export function mount(form: HTMLFormElement): void {
  const button = form.querySelector("button")!
  button.addEventListener("click", () => form.requestSubmit())
}
