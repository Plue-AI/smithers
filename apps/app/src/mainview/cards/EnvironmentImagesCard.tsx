import { Server } from "lucide-react"
import { StatusPill } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { settledPill, type CardFamily } from "./CardFamily"

const imageTag = (image: string | null | undefined): string | null => {
  if (image === null || image === undefined || image === "") return null
  const cut = image.lastIndexOf(":")
  if (cut < 0) return null
  const tag = image.slice(cut + 1)
  return tag === "" || tag.includes("/") ? null : tag
}

export const EnvironmentImagesCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "environment-images" }>
}) => {
  const { repo, images } = card.payload
  return (
    <ul className="world-card-list">
      {images.length === 0 ?
        <li className="world-card-empty">{repo} has built no environment images.</li> :
        images.map((image) => (
          <li key={image.id} className="world-card-row">
            <Server size={14} aria-hidden="true" />
            <span className="world-card-title">{image.kind}</span>
            {image.closureHash === null ? null : <span className="world-card-path">{image.closureHash.slice(0, 8)}</span>}
            {imageTag(image.image) === null ? null : <span className="world-card-path">{imageTag(image.image)}</span>}
            <StatusPill status={image.status} />
            {image.platformBase ? <span className="world-card-path">platform base</span> : null}
            {image.coldPull ? <span className="world-card-path">first boot is a cold pull</span> : null}
          </li>
        ))}
    </ul>
  )
}

export const environmentImagesCardFamily: CardFamily<"environment-images"> = {
  "environment-images": { render: card => <EnvironmentImagesCardBody card={card} />, pill: settledPill }
}
