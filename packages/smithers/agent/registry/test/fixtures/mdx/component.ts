import settings from "./settings.json" with { type: "json" }

export const Greeting = (props: { readonly name: string }): string => `${settings.prefix}${props.name}`
