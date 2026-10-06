import{readFileSync as fe}from"node:fs";/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var Y=/^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;class j extends Date{#t=!1;#n=!1;#e=null;constructor(e){let i=!0,t=!0,n="Z";if(typeof e==="string"){let r=e.match(Y);if(r){if(!r[1])i=!1,e=`0000-01-01T${e}`;if(t=!!r[2],t&&e[10]===" "&&(e=e.replace(" ","T")),r[2]&&+r[2]>23)e="";else if(n=r[3]||null,e=e.toUpperCase(),!n&&t)e+="Z"}else e=""}super(e);if(!isNaN(this.getTime()))this.#t=i,this.#n=t,this.#e=n}isDateTime(){return this.#t&&this.#n}isLocal(){return!this.#t||!this.#n||!this.#e}isDate(){return this.#t&&!this.#n}isTime(){return this.#n&&!this.#t}isValid(){return this.#t||this.#n}toISOString(){let e=super.toISOString();if(this.isDate())return e.slice(0,10);if(this.isTime())return e.slice(11,23);if(this.#e===null)return e.slice(0,-1);if(this.#e==="Z")return e;let i=+this.#e.slice(1,3)*60+ +this.#e.slice(4,6);return i=this.#e[0]==="-"?i:-i,new Date(this.getTime()-i*60000).toISOString().slice(0,-1)+this.#e}static wrapAsOffsetDateTime(e,i="Z"){let t=new j(e);return t.#e=i,t}static wrapAsLocalDateTime(e){let i=new j(e);return i.#e=null,i}static wrapAsLocalDate(e){let i=new j(e);return i.#n=!1,i.#e=null,i}static wrapAsLocalTime(e){let i=new j(e);return i.#t=!1,i.#e=null,i}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function Q(e,i){let t=e.slice(0,i).split(/\r\n|\n|\r/g);return[t.length,t.pop().length+1]}function B(e,i,t){let n=e.split(/\r\n|\n|\r/g),r="",o=(Math.log10(i+1)|0)+1;for(let l=i-1;l<=i+1;l++){let d=n[l-1];if(!d)continue;if(r+=l.toString().padEnd(o," "),r+=":  ",r+=d,r+=`
`,l===i)r+=" ".repeat(o+t+2),r+=`^
`}return r}class p extends Error{line;column;codeblock;constructor(e,i){let[t,n]=Q(i.toml,i.ptr),r=B(i.toml,t,n);super(`Invalid TOML document: ${e}

${r}`,i);this.line=t,this.column=n,this.codeblock=r}}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function F(e,i=0){let t=e.indexOf(`
`,i);if(e.charCodeAt(t-1)===13)t--;return t}function x(e){for(;e.p<e.s.length;e.p++){let i=e.s.charCodeAt(e.p);if(i===10)break;if(i===13&&e.s.charCodeAt(e.p+1)===10){e.p++;break}if(i<32&&i!==9||i===127)throw new p("control characters are not allowed in comments",{toml:e.s,ptr:e.p})}}function b(e,i,t){let n;while(!0){while((n=e.s.charCodeAt(e.p))===32||n===9||!i&&(n===10||n===13&&e.s.charCodeAt(e.p+1)===10))e.p++;if(t||n!==35)break;x(e)}}function D(e,i,t){let n=e.p;if(!t){n=F(e.s,n),e.p=n<0?e.s.length:n;return}for(;e.p<e.s.length;e.p++){let r=e.s.charCodeAt(e.p);if(r===35)x(e);else if(r===t||r===i)return}throw new p("cannot find end of structure",{toml:e.s,ptr:n})}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var ee=/^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/,te=/^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/,ne=/^[+-]?0[0-9_]/;function U(e){let i=e.p,t=e.s.charCodeAt(e.p++),n=t,r=t===39,o=t===e.s.charCodeAt(e.p)&&t===e.s.charCodeAt(e.p+1);if(o){if((t=e.s.charCodeAt(e.p+=2))===10)e.p++;else if(t===13&&e.s.charCodeAt(e.p+1)===10)e.p+=2}let l="",d=e.p,a=0;for(;e.p<e.s.length;e.p++)if(t=e.s.charCodeAt(e.p),o&&(t===10||t===13&&e.s.charCodeAt(e.p+1)===10))a=a&&3;else if(t<32&&t!==9||t===127)throw new p("control characters are not allowed in strings",{toml:e.s,ptr:e.p});else if((!a||a===3)&&t===n&&(!o||e.s.charCodeAt(e.p+1)===n&&e.s.charCodeAt(e.p+2)===n)){if(o){if(e.s.charCodeAt(e.p+3)===n)e.p++;if(e.s.charCodeAt(e.p+3)===n)e.p++}if(!a)l+=e.s.slice(d,e.p);return e.p+=o?3:1,l}else if(!a){if(!r&&t===92)l+=e.s.slice(d,d=e.p),a=1}else if(a===1)if(t===120||t===117||t===85){let c=0,g=t===120?2:t===117?4:8;for(let y=0;y<g;y++,e.p++){let w=e.s.charCodeAt(e.p+1),u=w>=48&&w<=57?w-48:w>=65&&w<=70?w-65+10:w>=97&&w<=102?w-97+10:-1;if(u<0)throw new p("invalid non-hex character in unicode escape",{toml:e.s,ptr:e.p+1});c=c<<4|u}if(c<0||c>1114111||c>=55296&&c<=57343)throw new p("invalid unicode escape",{toml:e.s,ptr:e.p});l+=String.fromCodePoint(c),d=e.p+1,a=0}else if(t===32||t===9)a=2;else{if(t===98)l+="\b";else if(t===116)l+="\t";else if(t===110)l+=`
`;else if(t===102)l+="\f";else if(t===114)l+="\r";else if(t===101)l+="\x1B";else if(t===34)l+='"';else if(t===92)l+="\\";else throw new p("unrecognized escape sequence",{toml:e.s,ptr:e.p});d=e.p+1,a=0}else if(t!==32&&t!==9){if(a===2)throw new p("invalid escape: only line-ending whitespace may be escaped",{toml:e.s,ptr:d});a=!r&&t===92?1:0,d=e.p}throw new p("unfinished string",{toml:e.s,ptr:i})}function re(e,i,t){let n=e.s.slice(i,t),r=n.indexOf("#");if(r>0)x({s:n,p:r,d:0}),n=n.slice(0,r);return n.trimEnd()}function I(e,i,t){let n=e.p,r={toml:e.s,ptr:n};D(e,44,t);let o=re(e,n,e.p);if(!o)throw new p("incomplete declaration: value expected",r);if(o==="-inf")return-1/0;if(o==="inf"||o==="+inf")return 1/0;if(o==="nan"||o==="+nan"||o==="-nan")return NaN;if(o==="-0")return i?0n:0;let l=ee.test(o);if(l||te.test(o)){if(ne.test(o))throw new p("leading zeroes are not allowed",r);o=o.replace(/_/g,"");let a=+o;if(isNaN(a))throw new p("invalid number",r);if(l){if((l=!Number.isSafeInteger(a))&&!i)throw new p("integer value cannot be represented losslessly",r);if(l||i===!0)a=BigInt(o)}return a}let d=new j(o);if(!d.isValid())throw new p("invalid value",r);return d}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function O(e,i,t){let n=e.p,r=e.s.charCodeAt(n);if(r===91||r===123){if(!e.d--)throw new p("document contains excessively nested structures. aborting.",{toml:e.s,ptr:n});let o=r===91?G(e,t):P(e,t);return e.d++,o}if(r===34||r===39)return U(e);if(r===116){if(e.s.charCodeAt(++e.p)!==114||e.s.charCodeAt(++e.p)!==117||e.s.charCodeAt(++e.p)!==101)throw new p("invalid value",{toml:e.s,ptr:n});return e.p++,!0}if(r===102){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==108||e.s.charCodeAt(++e.p)!==115||e.s.charCodeAt(++e.p)!==101)throw new p("invalid value",{toml:e.s,ptr:n});return e.p++,!1}return I(e,t,i)}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var ie=/^[a-zA-Z0-9-_]+[ \t]*$/;function N(e,i="="){let t=e.p,n=t-1,r=[],o=e.s.indexOf(i,t);if(o<0)throw new p("incomplete key-value: cannot find end of key",{toml:e.s,ptr:t});do{let l=e.s.charCodeAt(e.p=++n);if(l!==32&&l!==9)if(l===34||l===39){if(l===e.s.charCodeAt(e.p+1)&&l===e.s.charCodeAt(e.p+2))throw new p("multiline strings are not allowed in keys",{toml:e.s,ptr:e.p});let d=U(e);n=e.s.indexOf(".",e.p);let a=e.s.slice(e.p,n<0||n>o?o:n),c=F(a);if(c>-1)throw new p("newlines are not allowed in keys",{toml:e.s,ptr:c});if(a.trimStart())throw new p("found extra tokens after the string part",{toml:e.s,ptr:e.p});if(o<e.p){if(o=e.s.indexOf(i,e.p),o<0)throw new p("incomplete key-value: cannot find end of key",{toml:e.s,ptr:t})}r.push(d)}else{n=e.s.indexOf(".",e.p);let d=e.s.slice(e.p,n<0||n>o?o:n);if(!ie.test(d))throw new p("only letter, numbers, dashes and underscores are allowed in keys",{toml:e.s,ptr:e.p});r.push(d.trimEnd())}}while(n+1&&n<o);return e.p=o+1,b(e,!0,!0),r}function P(e,i){let t={},n=new Set,r;e.p++;while(e.p<e.s.length){if(b(e),(r=e.s.charCodeAt(e.p))===125)return e.p++,t;let o,l=t,d=!1,a=e.p,c=N(e);for(let y=0;y<c.length;y++){if(y)l=d?l[o]:l[o]={};if(o=c[y],(d=Object.hasOwn(l,o))&&(typeof l[o]!=="object"||n.has(l[o])))throw new p("trying to redefine an already defined value",{toml:e.s,ptr:a});if(!d&&o==="__proto__")Object.defineProperty(l,o,{enumerable:!0,configurable:!0,writable:!0})}if(d)throw new p("trying to redefine an already defined value",{toml:e.s,ptr:e.p});let g=O(e,125,i);if(n.add(l[o]=g),b(e),(r=e.s.charCodeAt(e.p++))===125)return t;if(r!==44)throw new p("expected comma or end of structure",{toml:e.s,ptr:e.p-1})}throw new p("unfinished table encountered",{toml:e.s,ptr:e.p})}function G(e,i){let t=[],n;e.p++;while(e.p<e.s.length){if(b(e),(n=e.s.charCodeAt(e.p))===93)return e.p++,t;if(t.push(O(e,93,i)),b(e),(n=e.s.charCodeAt(e.p++))===93)return t;if(n!==44)throw new p("expected comma or end of structure",{toml:e.s,ptr:e.p-1})}throw new p("unfinished array encountered",{toml:e.s,ptr:e.p})}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */function L(e,i,t,n){let r=i,o=t,l,d=!1,a;for(let c=0;c<e.length;c++){if(c){if(r=d?r[l]:r[l]={},o=(a=o[l]).c,n===0&&(a.t===1||a.t===2))return null;if(a.t===2){let g=r.length-1;r=r[g],o=o[g].c}}if(l=e[c],(d=Object.hasOwn(r,l))&&o[l]?.t===0&&o[l]?.d)return null;if(!d){if(l==="__proto__")Object.defineProperty(r,l,{enumerable:!0,configurable:!0,writable:!0}),Object.defineProperty(o,l,{enumerable:!0,configurable:!0,writable:!0});o[l]={t:c<e.length-1&&n===2?3:n,d:!1,i:0,c:{}}}}if(a=o[l],a.t!==n&&!(n===1&&a.t===3))return null;if(n===2){if(!a.d)a.d=!0,r[l]=[];r[l].push(r={}),a.c[a.i++]=a={t:1,d:!1,i:0,c:{}}}if(a.d)return null;if(a.d=!0,n===1)r=d?r[l]:r[l]={};else if(n===0&&d)return null;return[l,r,a.c]}function M(e,{maxDepth:i=1000,integersAsBigInt:t}={}){let n={s:e,p:0,d:i},r={},o={},l,d=r,a=o;b(n);while(n.p<e.length){if(e.charCodeAt(n.p)===91){let c=e.charCodeAt(++n.p)===91;l=n.p+=+c;let g=N(n,"]");if(c){if(e.charCodeAt(n.p-1)!==93)throw new p("expected end of table declaration",{toml:e,ptr:n.p-1});n.p++}let y=L(g,r,o,c?2:1);if(!y)throw new p("trying to redefine an already defined table or value",{toml:e,ptr:l});a=y[2],d=y[1]}else{l=n.p;let c=N(n),g=L(c,d,a,0);if(!g)throw new p("trying to redefine an already defined table or value",{toml:e,ptr:l});g[1][g[0]]=O(n,void 0,t)}if(b(n,!0),n.p<e.length&&(l=e.charCodeAt(n.p))!==10&&l!==13)throw new p("each key-value declaration must be followed by an end-of-line",{toml:e,ptr:n.p});b(n)}return r}/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *//*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */var V={ci:{id:"ci",question:"Run this in CI?"},incremental:{id:"incremental",question:"Make it incremental, so unchanged inputs reuse their recorded result?"}},z=(e)=>{if(e===void 0)return{};try{let i=JSON.parse(e),t=typeof i==="object"&&i!==null&&"scripts"in i?i.scripts:void 0;if(typeof t!=="object"||t===null)return{};return Object.fromEntries(Object.entries(t).filter((n)=>typeof n[1]==="string"))}catch{return{}}},oe=(e,i)=>{if(e===void 0)return;try{let t=JSON.parse(e);return typeof t==="object"&&t!==null&&i in t?t[i]:void 0}catch{return}},q=(e,i)=>i.find((t)=>e.exists(t)),J=[["pnpm-lock.yaml","pnpm"],["bun.lock","bun"],["bun.lockb","bun"],["yarn.lock","yarn"],["package-lock.json","npm"]],se=["eslint.config.js","eslint.config.mjs","eslint.config.ts",".eslintrc",".eslintrc.js",".eslintrc.cjs",".eslintrc.json","biome.json","biome.jsonc","dprint.json",".prettierrc","ruff.toml",".golangci.yml","clippy.toml"],le=[["vitest.config.ts","vitest"],["vitest.config.mts","vitest"],["vitest.config.js","vitest"],["vitest.workspace.ts","vitest"],["jest.config.js","jest"],["jest.config.ts","jest"],["jest.config.mjs","jest"],["bunfig.toml","bun test"],["pytest.ini","pytest"],["Cargo.toml","cargo test"],["go.mod","go test"]];class C extends Error{code="invalid_machine_recipe";class="user";fix;constructor(e,i){super(`${e}: ${i}`);this.fix=`Change ${e}`}}var Ge=[".node-version",".nvmrc","package.json",...J.map(([e])=>e),"go.mod","rust-toolchain.toml","Cargo.toml",".python-version","pyproject.toml","uv.lock","requirements.txt"],ae=(e)=>{let i={detectorVersion:"smithers.toolchain-detect/v4",tools:{},installs:[]},t=(s)=>e.exists(s),n=(s)=>e.read(s)??"",r=(s,f)=>{throw new C(s,f)},o=(s)=>/^[0-9]+(?:\.[0-9]+){0,2}$/.test(s),l=(s)=>s==="stable"||s.split("||").every((f)=>f.replaceAll(","," ").trim().split(/\s+/).every((k)=>/^(?:>=|<=|==|>|<|=|\^|~)?[0-9]+(?:\.[0-9]+){0,2}(?:\.[x*])?$/.test(k))),d=(s,f,h,k=!1)=>{if(f=f.trim(),f!==""&&!(k?l(f):o(f))&&!(s==="rust"&&f==="stable"))r(h,`invalid ${s} version ${f}`);i.tools[s]={version:f,file:h}},a=(s,f,h,k)=>{i.installs.push({command:s,...f===void 0?{}:{offline:f},files:h.sort(),destinations:k.sort()})},c=(s,f=!1)=>{if(!t(s))return{};try{return f?M(n(s)):JSON.parse(n(s))}catch{return r(s,f?"invalid TOML":"invalid JSON")}},g=c("package.json");if(g===null||typeof g!=="object"||Array.isArray(g))r("package.json","expected an object");for(let s of[g.packageManager,g.engines?.node])if(s!==void 0&&typeof s!=="string")r("package.json","expected a string");let y=g.engines?.node??"",w="package.json";for(let s of[".nvmrc",".node-version"])if(t(s))y=n(s).trim().replace(/^v/,""),w=s;if(w!=="package.json"&&!o(y))r(w,"expected one numeric version");if(t("package.json")||y!=="")d("node",y,w,w==="package.json");let u="",S="",R="package.json",A=g.packageManager??"";if(A!==""){let s=A.indexOf("@");u=s<0?A:A.slice(0,s),S=s<0?"":A.slice(s+1).split("+sha")[0]}let v=[];for(let[s,f]of J){if(!t(s))continue;if(A===""&&u!==""&&u!==f)r([...v,s].join(" and "),"conflicting package-manager lockfiles; set package.json#packageManager");if(u==="")u=f,R=s;if(u===f)v.push(s)}if(u===""&&t("package.json"))u="npm";if(u!==""){if(!["npm","pnpm","yarn","bun"].includes(u))r(R,`unsupported package manager ${u}`);if(i.tools.node===void 0)d("node","",R);d(u,S,R),i.packageManager=u;let s=u==="npm"&&v.length>0?["npm","ci"]:[u,"install",...v.length>0&&u!=="npm"?["--frozen-lockfile"]:[]],f=u==="pnpm"&&v.length>0?["pnpm","install","--offline","--frozen-lockfile"]:[...s,"--offline"];a(s,f,["package.json",...v],["registry.npmjs.org","registry.yarnpkg.com"])}if(t("go.mod")){let s="",f=new Set;for(let h of n("go.mod").matchAll(/^\s*(go|toolchain)\s+(\S+)\s*(?:\/\/[^\n]*)?$/gm)){let k=h[1],_=h[2];if(f.has(k))r("go.mod",`duplicate ${k} directive`);if(f.add(k),k==="go"&&s==="")s=_;if(k==="toolchain"&&_!=="default")s=_.replace(/^go/,"")}if(s==="")r("go.mod","missing go directive");d("go",s,"go.mod"),a(["go","mod","download"],void 0,["go.mod"],["proxy.golang.org","sum.golang.org","storage.googleapis.com"])}let m=c("Cargo.toml",!0),H=c("rust-toolchain.toml",!0);if(t("Cargo.toml")||t("rust-toolchain.toml")){let s=m.package?.["rust-version"]??"",f="Cargo.toml";if(t("rust-toolchain.toml")){if(s=H.toolchain?.channel??"",f="rust-toolchain.toml",s==="")r(f,"missing toolchain.channel")}else if(s!==""){if(typeof s!=="string"||!o(s))r(f,"expected one numeric minimum Rust version");s=`>=${s}`}if(typeof s!=="string")r(f,"expected a string");if(d("rust",s||"stable",f,f==="Cargo.toml"),t("Cargo.toml"))a(["cargo","fetch"],void 0,["Cargo.toml","rust-toolchain.toml"],["index.crates.io","static.crates.io"])}let W=c("pyproject.toml",!0),T=e.list("").filter((s)=>/^requirements[^/\\\x00]*\.txt$/.test(s)&&t(s)).sort();if(t("pyproject.toml")||t(".python-version")||t("uv.lock")||T.length>0){let s=W.project?.["requires-python"]??"",f="pyproject.toml";if(t(".python-version")){if(s=n(".python-version").trim(),f=".python-version",!o(s))r(f,"expected one numeric version")}else if(!t("pyproject.toml"))f=t("uv.lock")?"uv.lock":T[0]??"requirements.txt";if(typeof s!=="string")r(f,"expected a string");if(d("python",s,f,f==="pyproject.toml"),t("uv.lock")||t("pyproject.toml")&&T.length===0){d("uv","","uv.lock");let h=["uv","sync",...t("uv.lock")?["--frozen"]:[]];a(h,[...h,"--offline"],["pyproject.toml","uv.lock"],["pypi.org","files.pythonhosted.org"])}else if(T.length>0){let h=T.flatMap((k)=>["-r",k]);a(["python","-m","pip","install",...h],["python","-m","pip","install","--no-index",...h],T,["pypi.org","files.pythonhosted.org"])}}let E=(s,f)=>{if(i.checks?.some((h)=>h.id===s))return;(i.checks??=[]).push({id:s,argv:f})},X=z(e.read("package.json"));for(let s of["test","lint","typecheck","build"]){let f=X[s];if(f?.trim()&&!f.includes("no test specified")){let h=i.packageManager??"npm";E(s,h==="npm"?["npm","run",s]:[h,s])}}for(let s of["test","lint","typecheck","format","build"])if(new RegExp(`^${s}\\s*:`,"m").test(n("Makefile")))E(s,["make",s]);if(t("go.mod"))E("test",["go","test","./..."]);if(t("Cargo.toml"))E("test",["cargo","test"]);if(t("pyproject.toml")||t("setup.py")||t("pytest.ini"))E("test",["pytest"]);return i},Z=(e)=>{let i=e.read("package.json"),t=z(i),n;try{n=ae(e)}catch(m){if(!(m instanceof C))throw m;n=m}let r=n instanceof C?void 0:n.packageManager,o=t.test,l=le.find(([m])=>e.exists(m)),d=o!==void 0?/vitest/.test(o)?"vitest":/jest/.test(o)?"jest":/bun test/.test(o)?"bun test":o:l?.[1],a=se.filter((m)=>e.exists(m)),g=[...e.list(".github/workflows").filter((m)=>/\.ya?ml$/.test(m)).map((m)=>`.github/workflows/${m}`),...[".gitlab-ci.yml",".circleci/config.yml","Jenkinsfile"].filter((m)=>e.exists(m))],y=e.list("flows").filter((m)=>e.exists(`flows/${m}/flow.mdx`)).map((m)=>`flows/${m}/flow.mdx`),w=e.exists(".git"),u=w?e.read(".git/config"):void 0,S=u!==void 0&&u.includes("github.com")||e.exists(".github"),R=oe(i,"workspaces"),A=[...e.exists("pnpm-workspace.yaml")?["pnpm-workspace.yaml"]:[],...Array.isArray(R)?["package.json#workspaces"]:[],...["packages","apps"].filter((m)=>e.list(m).length>0)],v=[...i===void 0?[]:["javascript"],...e.exists("tsconfig.json")?["typescript"]:[],...e.exists("Cargo.toml")?["rust"]:[],...e.exists("go.mod")?["go"]:[],...e.exists("pyproject.toml")?["python"]:[]];return{machine:n,packageManager:r,scripts:t,testRunner:d,lint:a,ci:g,flows:y,packageFile:e.exists("PACKAGE.ts"),github:S,git:w,monorepo:A,agentsFile:q(e,["AGENTS.md","CLAUDE.md"]),changelog:q(e,["CHANGELOG.md",".changeset"]),language:v}};var Le=[V.ci,V.incremental];var K=(e,i)=>{let t=Object.keys(i),n=(r)=>t.some((o)=>o.startsWith(`${r}/`));return{root:e,exists:(r)=>Object.hasOwn(i,r)||n(r),read:(r)=>Object.hasOwn(i,r)?i[r]:void 0,list:(r)=>[...new Set(t.filter((o)=>r===""||o.startsWith(`${r}/`)).map((o)=>o.slice(r===""?0:r.length+1).split("/")[0]))].sort()}};try{let e=JSON.parse(fe(0,"utf8")),i=Z(K("/mirror",e)).machine;if(i instanceof C)throw i;process.stdout.write(JSON.stringify({recipe:i}))}catch(e){if(!(e instanceof C))throw e;process.stdout.write(JSON.stringify({error:{code:e.code,class:e.class,message:e.message,fix:e.fix}}))}
