export const RETAINED_GITHUB_SOURCE = "codeplanesmithers/smithers-e2e-import-s12-muekb67w-u8ijfvai"
export const RETAINED_GITHUB_ID = "1384168397"

/** Never turn a disposable repository into a retained fixture by accident. */
export const assertRetainedSource = (repo: string, id: string): void => {
  if (repo !== RETAINED_GITHUB_SOURCE || id !== RETAINED_GITHUB_ID) {
    throw new Error(`Refusing an unregistered retained GitHub source: ${repo} (${id})`)
  }
}

export const isPlueImportMode = (mode: string | undefined): boolean =>
  mode === "web-plue" || mode === "local-plue"
