// The full marker is absent from both commands: echoed keyboard input is not an execution receipt.
export const terminalExecutionProof = (nonce: string) => ({
  marker: `MATRIX_TERMINAL_${nonce}`,
  setValue: `MATRIX_TERMINAL_PROOF='${nonce}'`,
  readValue: `test "$MATRIX_TERMINAL_PROOF" = '${nonce}' && printf 'MATRIX_TERMINAL_%s\\n' "$MATRIX_TERMINAL_PROOF"`
})

export const terminalExecutionProved = (rows: string, marker: string): boolean => rows.includes(marker)
