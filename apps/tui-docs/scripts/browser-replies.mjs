/** Controlled provider replies for the real browser agent and its recordings. */
export const browserReplies = [
  "```cell\nconst before = await ctx.call(\"read\", {path:\"math.js\"});\nawait ctx.call(\"write\", {path:\"math.js\", content:\"export const add = (a, b) => a + b\\n\"});\nconst result = await ctx.call(\"check\", {});\nconsole.log(before, result);\n```",
  "```cell\nctx.done(\"Fixed math.js. Both checks pass.\");\n```"
]

export const completion = (content) => ({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }]
})
