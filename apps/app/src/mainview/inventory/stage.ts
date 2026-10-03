export function inventoryStage(value: string | undefined): "S1" | "S2" | "S3" {
  if (!value) throw new Error("inventory_stage_missing")
  if (value !== "S1" && value !== "S2" && value !== "S3") throw new Error(`inventory_stage_unknown: ${value}`)
  return value
}
