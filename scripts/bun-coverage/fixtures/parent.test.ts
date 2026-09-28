import { afterAll, expect, test } from "bun:test"
import { choose, late } from "./source.ts"
test("parent uses the negative branch", () => expect(choose(false)).toBe("negative"))
afterAll(() => expect(late()).toBe("teardown observed"))
