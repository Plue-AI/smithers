import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { link, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { z } from "zod"

const review = z.object({
  candidate: z.string().regex(/^[a-f0-9]{40}$/),
  operator: z.string().min(1),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime(),
  recording: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fullRun: z.literal(true),
  credentialsRemoved: z.literal(true)
})

/** Retain only the exact sanitized bytes a person reviewed. This is no check receipt. */
export async function retainReviewedRecording(input: {
  rawRecording: string
  candidate: string
  operator: string
  reviewPath: string | undefined
  destination: string
}) {
  const refuse = () => new Error("C-J1-04 recording_review_required: a separate full-run sanitized recording and candidate-bound human review are required")
  if (!input.reviewPath) throw refuse()
  // Do not echo validation input: a malformed review may itself contain credentials.
  let approved: z.infer<typeof review>
  try { approved = review.parse(JSON.parse(await readFile(input.reviewPath, "utf8"))) }
  catch { throw refuse() }
  if (approved.candidate !== input.candidate || approved.operator !== input.operator ||
      Date.parse(approved.reviewedAt) > Date.now()) throw refuse()
  if (await realpath(approved.recording) === await realpath(input.rawRecording)) throw refuse()
  const raw = await stat(input.rawRecording)
  const sanitized = await stat(approved.recording)
  if (!sanitized.isFile() || (raw.dev === sanitized.dev && raw.ino === sanitized.ino)) throw refuse()

  // Hash while copying so changed source bytes cannot slip between validation and
  // retention. Stream long recordings rather than loading a full hour into RAM.
  const temporary = await mkdtemp(join(dirname(input.destination), ".recording-review-"))
  const staging = join(temporary, "recording.mp4")
  const hash = createHash("sha256")
  let size = 0
  try {
    await pipeline(createReadStream(approved.recording), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        size += chunk.length
        callback(null, chunk)
      }
    }), createWriteStream(staging, { flags: "wx", mode: 0o600 }))
    if (!size || hash.digest("hex") !== approved.sha256) throw refuse()
    // Exclusive publication preserves an earlier recording rather than overwriting it.
    await link(staging, input.destination)
    return approved
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
