import { createRoot } from "react-dom/client"
import { Home } from "./Home"
import "@fontsource/inter/latin-400.css"
import "@fontsource/inter/latin-600.css"
import "@fontsource/ibm-plex-mono/latin-400.css"
import "./home.css"

createRoot(document.getElementById("root")!).render(<Home />)
