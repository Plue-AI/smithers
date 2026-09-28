export function optional(input?: {value:number}) {return input?.value;}
export function nullish(input?:number|null) {return input ?? 9;}
export function logic(input:number) {return input || 9;}
export function assignments(input?:number|null) {
 let a=input,b=input,c=input;
 a ||= 9;
 b &&= 7;
 c ??= 5;
 return [a,b,c];
}
export function defaults(input=9) {return input;}
export async function asyncChoice(flag:boolean) {if(flag)return 1;return 2;}
export function* generatorChoice(flag:boolean) {yield flag ? 1 : 2;}
export function construct(flag:boolean) {
 class Box { value=flag ? 1 : 2; }
 return new Box().value;
}
export enum Numeric {Zero,Two=2}
export enum Textual {Value="value"}
export namespace Space {export function choose(flag:boolean){return flag ? 3 : 4;}}
