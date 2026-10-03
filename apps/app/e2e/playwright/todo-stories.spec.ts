import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { todoStories } from "../../src/mainview/cards/views/TodoView.stories";
const shots = `${homedir()}/design-lanes/shots/T-UI-04`;
mkdirSync(shots, { recursive: true });
for (const name of Object.keys(todoStories))
  for (const theme of ["light", "dark"])
    for (const width of [1280, 390])
      test(`${name} ${theme} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`/todo-stories.html?story=${name}&theme=${theme}`);
        await expect(page.getByRole("article")).toBeVisible();
        await expect(page.getByRole("heading", { name: "T12 Card model contracts" })).toBeVisible();
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `${shots}/${name}-${theme}-${width}.png`, fullPage: true });
        await page.addScriptTag({ path: "/tmp/t-ui-04-axe.js" });
        const result = await page.evaluate(async () => (window as any).axe.run());
        writeFileSync(`${shots}/${name}-${theme}-${width}.axe.json`, JSON.stringify(result, null, 2));
        expect(
          result.violations.filter((violation: any) => ["serious", "critical"].includes(violation.impact)),
        ).toEqual([]);
      });
test("answer and late draft use their supplied actions", async ({ page }) => {
  await page.goto("/todo-stories.html?story=needs_you");
  await page.getByRole("textbox", { name: "Answer", exact: true }).fill("Yes, optional");
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-action",
    JSON.stringify({ tag: "todo.answer", args: { n: "12", wait: "wait-question-1", answer: "Yes, optional" } }),
  );
  await page.goto("/todo-stories.html?story=late_answer");
  await page.getByRole("textbox", { name: "Steer", exact: true }).fill("Keep my answer");
  await page.getByRole("button", { name: "Send as steer" }).click();
  await expect(page.getByRole("textbox", { name: "Steer", exact: true })).toHaveValue("Keep my answer");
  await expect(page.locator("body")).toHaveAttribute(
    "data-last-action",
    JSON.stringify({ tag: "todo.steer", args: { n: "12", text: "Keep my answer" } }),
  );
});
