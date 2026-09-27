/** Run in the page before measuring layout; cancellation also ends an animation. */
export const settleAnimations = async (): Promise<void> => {
  await Promise.all(document.getAnimations().map(animation => animation.finished.catch(error => {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error
  })))
}
