import { z } from "zod"

const amountUsd = z.number().finite().positive().refine((value) => {
  if (value > 10_000_000_000) return false
  const decimal = value.toFixed(9)
  if (Number(decimal) !== value) return false
  const nanos = BigInt(decimal.replace(".", ""))
  return nanos > 0n && nanos <= 9223372036854775807n
})
const login = z.string().trim().toLowerCase().min(1).max(255)
const operationKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)

/** The product backend binds this key to one recipient, amount and administrator. */
export const AdminGrantRequestSchema = z.object({ login, amountUsd, operationKey }).strict()
export type AdminGrantRequest = z.infer<typeof AdminGrantRequestSchema>

const AdminGrantReceiptSchema = z.object({
  granted: z.literal(true),
  grantId: z.string().regex(/^credit-grant:[1-9][0-9]*$/),
  login: z.string().min(1).max(255),
  amountUsd,
  operationKey,
  duplicate: z.boolean()
}).strict()

/** An HTTP acknowledgment alone cannot mark a consequential write completed. */
export const adminGrantReceipt = (request: AdminGrantRequest, body: unknown, status: number) => {
  const parsed = AdminGrantReceiptSchema.safeParse(body)
  if (!parsed.success) return undefined
  const receipt = parsed.data
  if (
    receipt.login !== request.login || receipt.amountUsd !== request.amountUsd ||
    receipt.operationKey !== request.operationKey ||
    status !== 200
  ) return undefined
  return receipt
}
