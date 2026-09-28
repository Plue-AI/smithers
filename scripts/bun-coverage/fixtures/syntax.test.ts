import {test,expect} from "bun:test";
import * as s from "./syntax.ts";
test("modern JS and TS runtime syntax retain both outcomes",async()=>{
 expect(s.optional()).toBeUndefined(); expect(s.optional({value:2})).toBe(2);
 expect(s.nullish(null)).toBe(9); expect(s.nullish(2)).toBe(2);
 expect(s.logic(0)).toBe(9); expect(s.logic(2)).toBe(2);
 expect(s.assignments(0)).toEqual([9,0,0]); expect(s.assignments(2)).toEqual([2,7,2]);expect(s.assignments(null)).toEqual([9,null,5]);
 expect(s.defaults()).toBe(9);expect(s.defaults(2)).toBe(2);
 expect(await s.asyncChoice(true)).toBe(1);expect(await s.asyncChoice(false)).toBe(2);
 expect([...s.generatorChoice(true)]).toEqual([1]);expect([...s.generatorChoice(false)]).toEqual([2]);
 expect(s.construct(true)).toBe(1);expect(s.construct(false)).toBe(2);
 expect(s.Numeric[2]).toBe("Two");expect(s.Textual.Value).toBe("value");
 expect(s.Space.choose(true)).toBe(3);expect(s.Space.choose(false)).toBe(4);
});
