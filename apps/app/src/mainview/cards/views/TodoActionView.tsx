import type { Action } from "@smthrs/rpc/CardAction";
import type { TodoViewProps } from "@smthrs/rpc/TodoCard";
export function TodoActionView({
  action,
  onAction,
  drafts,
  onView,
}: {
  action: Action;
  onAction: TodoViewProps["onAction"];
  drafts: Record<string, string>;
  onView: (drafts: Record<string, string>) => void;
}) {
  const key = `${action.tag}:${action.args?.wait ?? "card"}`;
  const draft = Object.fromEntries(
    (action.input ?? []).map((field) => [
      field.name,
      drafts[`${key}:${field.name}`] ??
        (action.label === "Send as steer" && field.name === "text" ? drafts["late-answer"] : undefined) ??
        field.value ??
        "",
    ]),
  );
  if (action.disabled) return <span className="todo-disabled">{action.disabled.reason}</span>;
  const fields = action.input ?? [];
  if (!fields.length)
    return (
      <button
        type="button"
        data-flow={action.tag}
        data-primary={action.primary}
        onClick={() => onAction(action.tag, { ...action.args })}
      >
        {action.label}
      </button>
    );
  return (
    <form
      className="todo-form"
      data-flow={action.tag}
      onSubmit={(event) => {
        event.preventDefault();
        onAction(action.tag, {
          ...action.args,
          ...draft,
        });
      }}
    >
      {fields.map((field) => (
        <label key={field.name}>
          <span className="todo-sr">{field.label}</span>
          {field.kind === "choice" ? (
            <select
              aria-label={field.label}
              required={field.required}
              value={draft[field.name] ?? field.value ?? ""}
              onChange={(event) => onView({ ...drafts, [`${key}:${field.name}`]: event.target.value, ...(action.tag === "todo.answer" && field.name === "answer" ? { "late-answer": event.target.value } : {}) })}
            >
              <option value="" />
              {field.choices?.map((choice) => (
                <option key={choice}>{choice}</option>
              ))}
            </select>
          ) : field.multiline ? (
            <textarea
              aria-label={field.label}
              placeholder={field.label}
              required={field.required}
              value={draft[field.name] ?? field.value ?? ""}
              onChange={(event) => onView({ ...drafts, [`${key}:${field.name}`]: event.target.value, ...(action.tag === "todo.answer" && field.name === "answer" ? { "late-answer": event.target.value } : {}) })}
            />
          ) : (
            <input
              aria-label={field.label}
              placeholder={field.label}
              type={field.kind === "secret" ? "password" : "text"}
              required={field.required}
              value={draft[field.name] ?? field.value ?? ""}
              onChange={(event) => onView({ ...drafts, [`${key}:${field.name}`]: event.target.value, ...(action.tag === "todo.answer" && field.name === "answer" ? { "late-answer": event.target.value } : {}) })}
            />
          )}
        </label>
      ))}
      <button type="submit" data-flow={action.tag} data-primary={action.primary}>
        {action.label}
      </button>
    </form>
  );
}
