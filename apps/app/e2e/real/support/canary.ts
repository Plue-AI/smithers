// Reviewed literal data. Never derive the prompt or expected result from a
// mutable canary branch, a model response, a spec file or production code.
export const FIRST_TODO_PROMPT = 'Append the line "The first Smithers TODO was merged." after a blank line at the end of README.md. Change no other file. Run npm test.'
export const CANARY_README = "# Smithers MVP canary\n\nA small repository for release journey recordings.\n"
export const FIRST_TODO_README = CANARY_README + "\nThe first Smithers TODO was merged.\n"
