import { createRoot } from "react-dom/client"
import { ConfirmStory } from "./ConfirmView.stories"
import "../../styles/tokens.css"
import "../../styles/cards.css"
import "../../styles/views/confirm.css"

const name = new URLSearchParams(location.search).get("story") ?? "one_click"
createRoot(document.getElementById("root")!).render(<ConfirmStory name={name} />)
