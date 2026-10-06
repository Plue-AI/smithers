/** The retired library docs sites and their redirect targets (T-DOC-04, #3510). */
export const REPOSITORY_URL: string
export const README_URL: string
export const ZONE: string
export const legacySites: ReadonlyArray<readonly [slug: string, npmName: string]>
export const buildRedirectMap: (root?: string) => Readonly<Record<string, string>>
export const redirectMap: Readonly<Record<string, string>>
export const redirectLocation: (url: string) => string
export const GENERATED_MODULE: string
export const renderModule: (map: Readonly<Record<string, string>>) => string
