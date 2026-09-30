# Flow registry

Read the [flow registry skill](../../../../.agents/skills/smithers-flow-registry/SKILL.md) and its source guide for discovery, executable registration, or pack changes. Keep metadata listing separate from module import and execution.

Module `layer` exports are validated at load time only for services requested during layer construction; handler-only requirements are erased by Effect and stay the author's typed contract, so never add a runtime service manifest or execute handlers to probe them (#2923).
