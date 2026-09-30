# Agent packages

For `Agent.Service` loop or host composition work, read the [agent runtime skill](../../../.agents/skills/smithers-agent-runtime/SKILL.md) and its source guide. For registry, memory, or chain changes, follow the deeper scoped `AGENTS.md` and skills in those packages.

Native child recovery retains the control parent's ownership through a park. A released child beneath a live parked parent waits for an explicit resume; lease expiry must not silently restart external work. Background approval and wake notifications are not recovery consent. Unknown cross-machine liveness requires explicit resume; a parked timestamp is not a renewable lease. Preserve heartbeat fencing, cancellation, and recovery after confirmed owner death.
