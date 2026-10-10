/** Model fixture only. All effects run through the composed host's real calls. */
export const matrixFlowCell = (task: string): string | undefined => {
  const approval = /Approval marker: ([0-9a-f-]{36})/.exec(task)?.[1]
  const proof = /Matrix proof marker: ([0-9a-f-]{36})/.exec(task)?.[1]
  if (!approval && !proof) return undefined
  const marker = JSON.stringify(approval ?? proof)
  const source = approval
    ? `const decision = await ctx.call("ask", { question: "Approve the effect " + ${marker} + "?" });
if (decision.approved) await ctx.call("write", { path: "approval-effect.txt", content: ${marker} });
await ctx.call("write", { path: "approval-result.json", content: JSON.stringify({ marker: ${marker}, decision: decision.approved ? "approved" : "denied" }) });
ctx.done("recorded");`
    : `await ctx.call("write", { path: "flow-proof.txt", content: ${marker} + "\\n" }); ctx.done("written");`
  return "```cell\n" + source + "\n```"
}

export const approvalFlow = (marker: string): string => [
  "---",
  "description: Ask before writing an approval proof.",
  'capabilities: ["fs:read:**", "fs:write:**"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 60000",
  "  milliseconds: 240000",
  "---",
  "",
  `Approval marker: ${marker}`,
  `First call ask with question "Approve the effect ${marker}?". Wait for the actual human decision.`,
  `Only when approved is true, write approval-effect.txt containing ${marker}. Never write that file after denial.`,
  `After either decision, write approval-result.json with marker ${JSON.stringify(marker)} and decision "approved" or "denied" matching the returned approved boolean. Finish.`,
  ""
].join("\n")
