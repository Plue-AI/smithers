/// <reference types="astro/client" />

interface Window {
  /** Native host marker; the site only checks whether it is present. */
  __electrobun?: unknown
}
