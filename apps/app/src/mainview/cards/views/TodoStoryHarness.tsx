import { createRoot } from "react-dom/client";
import { TodoView } from "./TodoView";
import { todoStories } from "./TodoView.stories";
import "../../styles/tokens.css";
import "../../styles/views.css";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
document.body.style.cssText = "margin:0;padding:24px 12px;background:var(--surface-2)";
const name = params.get("story") as keyof typeof todoStories;
createRoot(document.getElementById("root")!).render(
  <TodoView
    {...(todoStories[name] ?? todoStories.working)}
    onAction={(tag, args) => {
      document.body.dataset.lastAction = JSON.stringify({ tag, args });
    }}
    onView={() => {}}
  />,
);
