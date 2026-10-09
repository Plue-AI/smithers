import{readFileSync as ae}from"node:fs";/*!
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
 */var W=/^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;class v extends Date{#t=!1;#n=!1;#e=null;constructor(e){let i=!0,t=!0,n="Z";if(typeof e==="string"){let r=e.match(W);if(r){if(!r[1])i=!1,e=`0000-01-01T${e}`;if(t=!!r[2],t&&e[10]===" "&&(e=e.replace(" ","T")),r[2]&&+r[2]>23)e="";else if(n=r[3]||null,e=e.toUpperCase(),!n&&t)e+="Z"}else e=""}super(e);if(!isNaN(this.getTime()))this.#t=i,this.#n=t,this.#e=n}isDateTime(){return this.#t&&this.#n}isLocal(){return!this.#t||!this.#n||!this.#e}isDate(){return this.#t&&!this.#n}isTime(){return this.#n&&!this.#t}isValid(){return this.#t||this.#n}toISOString(){let e=super.toISOString();if(this.isDate())return e.slice(0,10);if(this.isTime())return e.slice(11,23);if(this.#e===null)return e.slice(0,-1);if(this.#e==="Z")return e;let i=+this.#e.slice(1,3)*60+ +this.#e.slice(4,6);return i=this.#e[0]==="-"?i:-i,new Date(this.getTime()-i*60000).toISOString().slice(0,-1)+this.#e}static wrapAsOffsetDateTime(e,i="Z"){let t=new v(e);return t.#e=i,t}static wrapAsLocalDateTime(e){let i=new v(e);return i.#e=null,i}static wrapAsLocalDate(e){let i=new v(e);return i.#n=!1,i.#e=null,i}static wrapAsLocalTime(e){let i=new v(e);return i.#t=!1,i.#e=null,i}}/*!
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
 */function X(e,i){let t=e.slice(0,i).split(/\r\n|\n|\r/g);return[t.length,t.pop().length+1]}function Y(e,i,t){let n=e.split(/\r\n|\n|\r/g),r="",s=(Math.log10(i+1)|0)+1;for(let o=i-1;o<=i+1;o++){let l=n[o-1];if(!l)continue;if(r+=o.toString().padEnd(s," "),r+=":  ",r+=l,r+=`
`,o===i)r+=" ".repeat(s+t+2),r+=`^
`}return r}class c extends Error{line;column;codeblock;constructor(e,i){let[t,n]=X(i.toml,i.ptr),r=Y(i.toml,t,n);super(`Invalid TOML document: ${e}

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
`,i);if(e.charCodeAt(t-1)===13)t--;return t}function O(e){for(;e.p<e.s.length;e.p++){let i=e.s.charCodeAt(e.p);if(i===10)break;if(i===13&&e.s.charCodeAt(e.p+1)===10){e.p++;break}if(i<32&&i!==9||i===127)throw new c("control characters are not allowed in comments",{toml:e.s,ptr:e.p})}}function b(e,i,t){let n;while(!0){while((n=e.s.charCodeAt(e.p))===32||n===9||!i&&(n===10||n===13&&e.s.charCodeAt(e.p+1)===10))e.p++;if(t||n!==35)break;O(e)}}function I(e,i,t){let n=e.p;if(!t){n=F(e.s,n),e.p=n<0?e.s.length:n;return}for(;e.p<e.s.length;e.p++){let r=e.s.charCodeAt(e.p);if(r===35)O(e);else if(r===t||r===i)return}throw new c("cannot find end of structure",{toml:e.s,ptr:n})}/*!
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
 */var Q=/^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/,B=/^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/,ee=/^[+-]?0[0-9_]/;function S(e){let i=e.p,t=e.s.charCodeAt(e.p++),n=t,r=t===39,s=t===e.s.charCodeAt(e.p)&&t===e.s.charCodeAt(e.p+1);if(s){if((t=e.s.charCodeAt(e.p+=2))===10)e.p++;else if(t===13&&e.s.charCodeAt(e.p+1)===10)e.p+=2}let o="",l=e.p,a=0;for(;e.p<e.s.length;e.p++)if(t=e.s.charCodeAt(e.p),s&&(t===10||t===13&&e.s.charCodeAt(e.p+1)===10))a=a&&3;else if(t<32&&t!==9||t===127)throw new c("control characters are not allowed in strings",{toml:e.s,ptr:e.p});else if((!a||a===3)&&t===n&&(!s||e.s.charCodeAt(e.p+1)===n&&e.s.charCodeAt(e.p+2)===n)){if(s){if(e.s.charCodeAt(e.p+3)===n)e.p++;if(e.s.charCodeAt(e.p+3)===n)e.p++}if(!a)o+=e.s.slice(l,e.p);return e.p+=s?3:1,o}else if(!a){if(!r&&t===92)o+=e.s.slice(l,l=e.p),a=1}else if(a===1)if(t===120||t===117||t===85){let d=0,g=t===120?2:t===117?4:8;for(let h=0;h<g;h++,e.p++){let m=e.s.charCodeAt(e.p+1),w=m>=48&&m<=57?m-48:m>=65&&m<=70?m-65+10:m>=97&&m<=102?m-97+10:-1;if(w<0)throw new c("invalid non-hex character in unicode escape",{toml:e.s,ptr:e.p+1});d=d<<4|w}if(d<0||d>1114111||d>=55296&&d<=57343)throw new c("invalid unicode escape",{toml:e.s,ptr:e.p});o+=String.fromCodePoint(d),l=e.p+1,a=0}else if(t===32||t===9)a=2;else{if(t===98)o+="\b";else if(t===116)o+="\t";else if(t===110)o+=`
`;else if(t===102)o+="\f";else if(t===114)o+="\r";else if(t===101)o+="\x1B";else if(t===34)o+='"';else if(t===92)o+="\\";else throw new c("unrecognized escape sequence",{toml:e.s,ptr:e.p});l=e.p+1,a=0}else if(t!==32&&t!==9){if(a===2)throw new c("invalid escape: only line-ending whitespace may be escaped",{toml:e.s,ptr:l});a=!r&&t===92?1:0,l=e.p}throw new c("unfinished string",{toml:e.s,ptr:i})}function te(e,i,t){let n=e.s.slice(i,t),r=n.indexOf("#");if(r>0)O({s:n,p:r,d:0}),n=n.slice(0,r);return n.trimEnd()}function M(e,i,t){let n=e.p,r={toml:e.s,ptr:n};I(e,44,t);let s=te(e,n,e.p);if(!s)throw new c("incomplete declaration: value expected",r);if(s==="-inf")return-1/0;if(s==="inf"||s==="+inf")return 1/0;if(s==="nan"||s==="+nan"||s==="-nan")return NaN;if(s==="-0")return i?0n:0;let o=Q.test(s);if(o||B.test(s)){if(ee.test(s))throw new c("leading zeroes are not allowed",r);s=s.replace(/_/g,"");let a=+s;if(isNaN(a))throw new c("invalid number",r);if(o){if((o=!Number.isSafeInteger(a))&&!i)throw new c("integer value cannot be represented losslessly",r);if(o||i===!0)a=BigInt(s)}return a}let l=new v(s);if(!l.isValid())throw new c("invalid value",r);return l}/*!
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
 */function R(e,i,t){let n=e.p,r=e.s.charCodeAt(n);if(r===91||r===123){if(!e.d--)throw new c("document contains excessively nested structures. aborting.",{toml:e.s,ptr:n});let s=r===91?V(e,t):P(e,t);return e.d++,s}if(r===34||r===39)return S(e);if(r===116){if(e.s.charCodeAt(++e.p)!==114||e.s.charCodeAt(++e.p)!==117||e.s.charCodeAt(++e.p)!==101)throw new c("invalid value",{toml:e.s,ptr:n});return e.p++,!0}if(r===102){if(e.s.charCodeAt(++e.p)!==97||e.s.charCodeAt(++e.p)!==108||e.s.charCodeAt(++e.p)!==115||e.s.charCodeAt(++e.p)!==101)throw new c("invalid value",{toml:e.s,ptr:n});return e.p++,!1}return M(e,t,i)}/*!
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
 */var ne=/^[a-zA-Z0-9-_]+[ \t]*$/;function x(e,i="="){let t=e.p,n=t-1,r=[],s=e.s.indexOf(i,t);if(s<0)throw new c("incomplete key-value: cannot find end of key",{toml:e.s,ptr:t});do{let o=e.s.charCodeAt(e.p=++n);if(o!==32&&o!==9)if(o===34||o===39){if(o===e.s.charCodeAt(e.p+1)&&o===e.s.charCodeAt(e.p+2))throw new c("multiline strings are not allowed in keys",{toml:e.s,ptr:e.p});let l=S(e);n=e.s.indexOf(".",e.p);let a=e.s.slice(e.p,n<0||n>s?s:n),d=F(a);if(d>-1)throw new c("newlines are not allowed in keys",{toml:e.s,ptr:d});if(a.trimStart())throw new c("found extra tokens after the string part",{toml:e.s,ptr:e.p});if(s<e.p){if(s=e.s.indexOf(i,e.p),s<0)throw new c("incomplete key-value: cannot find end of key",{toml:e.s,ptr:t})}r.push(l)}else{n=e.s.indexOf(".",e.p);let l=e.s.slice(e.p,n<0||n>s?s:n);if(!ne.test(l))throw new c("only letter, numbers, dashes and underscores are allowed in keys",{toml:e.s,ptr:e.p});r.push(l.trimEnd())}}while(n+1&&n<s);return e.p=s+1,b(e,!0,!0),r}function P(e,i){let t={},n=new Set,r;e.p++;while(e.p<e.s.length){if(b(e),(r=e.s.charCodeAt(e.p))===125)return e.p++,t;let s,o=t,l=!1,a=e.p,d=x(e);for(let h=0;h<d.length;h++){if(h)o=l?o[s]:o[s]={};if(s=d[h],(l=Object.hasOwn(o,s))&&(typeof o[s]!=="object"||n.has(o[s])))throw new c("trying to redefine an already defined value",{toml:e.s,ptr:a});if(!l&&s==="__proto__")Object.defineProperty(o,s,{enumerable:!0,configurable:!0,writable:!0})}if(l)throw new c("trying to redefine an already defined value",{toml:e.s,ptr:e.p});let g=R(e,125,i);if(n.add(o[s]=g),b(e),(r=e.s.charCodeAt(e.p++))===125)return t;if(r!==44)throw new c("expected comma or end of structure",{toml:e.s,ptr:e.p-1})}throw new c("unfinished table encountered",{toml:e.s,ptr:e.p})}function V(e,i){let t=[],n;e.p++;while(e.p<e.s.length){if(b(e),(n=e.s.charCodeAt(e.p))===93)return e.p++,t;if(t.push(R(e,93,i)),b(e),(n=e.s.charCodeAt(e.p++))===93)return t;if(n!==44)throw new c("expected comma or end of structure",{toml:e.s,ptr:e.p-1})}throw new c("unfinished array encountered",{toml:e.s,ptr:e.p})}/*!
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
 */function G(e,i,t,n){let r=i,s=t,o,l=!1,a;for(let d=0;d<e.length;d++){if(d){if(r=l?r[o]:r[o]={},s=(a=s[o]).c,n===0&&(a.t===1||a.t===2))return null;if(a.t===2){let g=r.length-1;r=r[g],s=s[g].c}}if(o=e[d],(l=Object.hasOwn(r,o))&&s[o]?.t===0&&s[o]?.d)return null;if(!l){if(o==="__proto__")Object.defineProperty(r,o,{enumerable:!0,configurable:!0,writable:!0}),Object.defineProperty(s,o,{enumerable:!0,configurable:!0,writable:!0});s[o]={t:d<e.length-1&&n===2?3:n,d:!1,i:0,c:{}}}}if(a=s[o],a.t!==n&&!(n===1&&a.t===3))return null;if(n===2){if(!a.d)a.d=!0,r[o]=[];r[o].push(r={}),a.c[a.i++]=a={t:1,d:!1,i:0,c:{}}}if(a.d)return null;if(a.d=!0,n===1)r=l?r[o]:r[o]={};else if(n===0&&l)return null;return[o,r,a.c]}function D(e,{maxDepth:i=1000,integersAsBigInt:t}={}){let n={s:e,p:0,d:i},r={},s={},o,l=r,a=s;b(n);while(n.p<e.length){if(e.charCodeAt(n.p)===91){let d=e.charCodeAt(++n.p)===91;o=n.p+=+d;let g=x(n,"]");if(d){if(e.charCodeAt(n.p-1)!==93)throw new c("expected end of table declaration",{toml:e,ptr:n.p-1});n.p++}let h=G(g,r,s,d?2:1);if(!h)throw new c("trying to redefine an already defined table or value",{toml:e,ptr:o});a=h[2],l=h[1]}else{o=n.p;let d=x(n),g=G(d,l,a,0);if(!g)throw new c("trying to redefine an already defined table or value",{toml:e,ptr:o});g[1][g[0]]=R(n,void 0,t)}if(b(n,!0),n.p<e.length&&(o=e.charCodeAt(n.p))!==10&&o!==13)throw new c("each key-value declaration must be followed by an end-of-line",{toml:e,ptr:n.p});b(n)}return r}/*!
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
 */var L={ci:{id:"ci",question:"Run this in CI?"},incremental:{id:"incremental",question:"Make it incremental, so unchanged inputs reuse their recorded result?"}},re=(e)=>{if(e===void 0)return{};try{let i=JSON.parse(e),t=typeof i==="object"&&i!==null&&"scripts"in i?i.scripts:void 0;if(typeof t!=="object"||t===null)return{};return Object.fromEntries(Object.entries(t).filter((n)=>typeof n[1]==="string"))}catch{return{}}},z=(e,i)=>{if(e===void 0)return;try{let t=JSON.parse(e);return typeof t==="object"&&t!==null&&i in t?t[i]:void 0}catch{return}},q=(e,i)=>i.find((t)=>e.exists(t)),J=[["pnpm-lock.yaml","pnpm"],["bun.lock","bun"],["bun.lockb","bun"],["yarn.lock","yarn"],["package-lock.json","npm"]],ie=["eslint.config.js","eslint.config.mjs","eslint.config.ts",".eslintrc",".eslintrc.js",".eslintrc.cjs",".eslintrc.json","biome.json","biome.jsonc","dprint.json",".prettierrc","ruff.toml",".golangci.yml","clippy.toml"],oe=[["vitest.config.ts","vitest"],["vitest.config.mts","vitest"],["vitest.config.js","vitest"],["vitest.workspace.ts","vitest"],["jest.config.js","jest"],["jest.config.ts","jest"],["jest.config.mjs","jest"],["bunfig.toml","bun test"],["pytest.ini","pytest"],["Cargo.toml","cargo test"],["go.mod","go test"]];class A extends Error{code="invalid_machine_recipe";class="user";fix;constructor(e,i){super(`${e}: ${i}`);this.fix=`Change ${e}`}}var Pe=[".node-version",".nvmrc","package.json",...J.map(([e])=>e),"go.mod","rust-toolchain.toml","Cargo.toml",".python-version","pyproject.toml","uv.lock","requirements.txt"],Z=(e)=>{let i=(d)=>e.exists(d),t=(d,g)=>{throw new A(d,g)},n="",r="",s="package.json",o=z(e.read("package.json"),"packageManager");if(o!==void 0&&typeof o!=="string")t("package.json","expected a string");let l=typeof o==="string"?o:"";if(l!==""){let d=l.indexOf("@");n=d<0?l:l.slice(0,d),r=d<0?"":l.slice(d+1).split("+sha")[0]}let a=[];for(let[d,g]of J){if(!i(d))continue;if(l===""&&n!==""&&n!==g)t([...a,d].join(" and "),"conflicting package-manager lockfiles; set package.json#packageManager");if(n==="")n=g,s=d;if(n===g)a.push(d)}if(n===""&&i("package.json"))n="npm";if(n!==""&&!["npm","pnpm","yarn","bun"].includes(n))t(s,`unsupported package manager ${n}`);return{manager:n,managerVersion:r,managerFile:s,chosen:a}},se=(e,i,t)=>{let n=[],r=(l)=>e.exists(l),s=(l)=>e.read(l)??"",o=(l,a)=>{if(n.some((d)=>d.id===l))return;n.push({id:l,argv:a})};for(let l of["test","lint","typecheck","build"]){let a=t[l];if(i!==void 0&&a?.trim()&&!a.includes("no test specified")){let d=i;o(l,d==="npm"?["npm","run",l]:[d,l])}}for(let l of["test","lint","typecheck","format","build"])if(new RegExp(`^${l}\\s*:`,"m").test(s("Makefile")))o(l,["make",l]);if(r("go.mod"))o("test",["go","test","./..."]);if(r("Cargo.toml"))o("test",["cargo","test"]);if(r("pyproject.toml")||r("setup.py")||r("pytest.ini"))o("test",["pytest"]);return n},le=(e)=>{let i={detectorVersion:"smithers.toolchain-detect/v4",tools:{},installs:[]},t=(f)=>e.exists(f),n=(f)=>e.read(f)??"",r=(f,p)=>{throw new A(f,p)},s=(f)=>/^[0-9]+(?:\.[0-9]+){0,2}$/.test(f),o=(f)=>f==="stable"||f.split("||").every((p)=>p.replaceAll(","," ").trim().split(/\s+/).every((k)=>/^(?:>=|<=|==|>|<|=|\^|~)?[0-9]+(?:\.[0-9]+){0,2}(?:\.[x*])?$/.test(k))),l=(f,p,y,k=!1)=>{if(p=p.trim(),p!==""&&!(k?o(p):s(p))&&!(f==="rust"&&p==="stable"))r(y,`invalid ${f} version ${p}`);i.tools[f]={version:p,file:y}},a=(f,p,y,k)=>{i.installs.push({command:f,...p===void 0?{}:{offline:p},files:y.sort(),destinations:k.sort()})},d=(f,p=!1)=>{if(!t(f))return{};try{return p?D(n(f)):JSON.parse(n(f))}catch{return r(f,p?"invalid TOML":"invalid JSON")}},g=d("package.json");if(g===null||typeof g!=="object"||Array.isArray(g))r("package.json","expected an object");for(let f of[g.packageManager,g.engines?.node])if(f!==void 0&&typeof f!=="string")r("package.json","expected a string");let h=g.engines?.node??"",m="package.json";for(let f of[".nvmrc",".node-version"])if(t(f))h=n(f).trim().replace(/^v/,""),m=f;if(m!=="package.json"&&!s(h))r(m,"expected one numeric version");if(t("package.json")||h!=="")l("node",h.replace(/^v/,""),m,m==="package.json");let{manager:w,managerVersion:T,managerFile:E,chosen:j}=Z(e);if(w!==""){if(i.tools.node===void 0)l("node","",E);l(w,T,E),i.packageManager=w;let f=w==="npm"&&j.length>0?["npm","ci"]:[w,"install",...w==="npm"?["--package-lock=false"]:j.length>0?["--frozen-lockfile"]:[]],p=w==="pnpm"&&j.length>0?["pnpm","install","--offline","--frozen-lockfile"]:[...f,"--offline"];a(f,p,["package.json",...j],["registry.npmjs.org","registry.yarnpkg.com"])}if(t("go.mod")){let f="",p=new Set;for(let y of n("go.mod").matchAll(/^\s*(go|toolchain)\s+(\S+)\s*(?:\/\/[^\n]*)?$/gm)){let k=y[1],_=y[2];if(p.has(k))r("go.mod",`duplicate ${k} directive`);if(p.add(k),k==="go"&&f==="")f=_;if(k==="toolchain"&&_!=="default")f=_.replace(/^go/,"")}if(f==="")r("go.mod","missing go directive");l("go",f,"go.mod"),a(["go","mod","download"],void 0,["go.mod"],["proxy.golang.org","sum.golang.org","storage.googleapis.com"])}let U=d("Cargo.toml",!0),N=d("rust-toolchain.toml",!0);if(t("Cargo.toml")||t("rust-toolchain.toml")){let f=U.package?.["rust-version"]??"",p="Cargo.toml";if(t("rust-toolchain.toml")){if(f=N.toolchain?.channel??"",p="rust-toolchain.toml",f==="")r(p,"missing toolchain.channel")}else if(f!==""){if(typeof f!=="string"||!s(f))r(p,"expected one numeric minimum Rust version");f=`>=${f}`}if(typeof f!=="string")r(p,"expected a string");if(l("rust",f||"stable",p,p==="Cargo.toml"),t("Cargo.toml"))a(["cargo","fetch"],void 0,["Cargo.toml","rust-toolchain.toml"],["index.crates.io","static.crates.io"])}let u=d("pyproject.toml",!0),C=e.list("").filter((f)=>/^requirements[^/\\\x00]*\.txt$/.test(f)&&t(f)).sort();if(t("pyproject.toml")||t(".python-version")||t("uv.lock")||C.length>0){let f=u.project?.["requires-python"]??"",p="pyproject.toml";if(t(".python-version")){if(f=n(".python-version").trim(),p=".python-version",!s(f))r(p,"expected one numeric version")}else if(!t("pyproject.toml"))p=t("uv.lock")?"uv.lock":C[0]??"requirements.txt";if(typeof f!=="string")r(p,"expected a string");if(l("python",f,p,p==="pyproject.toml"),t("uv.lock")||t("pyproject.toml")&&C.length===0){l("uv","","uv.lock");let y=["uv","sync",...t("uv.lock")?["--frozen"]:[]];a(y,[...y,"--offline"],["pyproject.toml","uv.lock"],["pypi.org","files.pythonhosted.org"])}else if(C.length>0){let y=C.flatMap((k)=>["-r",k]);a(["python","-m","pip","install",...y],["python","-m","pip","install","--no-index",...y],C,["pypi.org","files.pythonhosted.org"])}}return i},K=(e)=>{let i=e.read("package.json"),t=re(i),n;try{n=le(e)}catch(u){if(!(u instanceof A))throw u;n=u}let r;try{r=Z(e).manager||void 0}catch(u){if(!(u instanceof A))throw u}let s=se(e,r,t);if(!(n instanceof A)&&s.length>0)n.checks=s;let o=t.test,l=oe.find(([u])=>e.exists(u)),a=o!==void 0?/vitest/.test(o)?"vitest":/jest/.test(o)?"jest":/bun test/.test(o)?"bun test":o:l?.[1],d=ie.filter((u)=>e.exists(u)),h=[...e.list(".github/workflows").filter((u)=>/\.ya?ml$/.test(u)).map((u)=>`.github/workflows/${u}`),...[".gitlab-ci.yml",".circleci/config.yml","Jenkinsfile"].filter((u)=>e.exists(u))],m=e.list("flows").filter((u)=>e.exists(`flows/${u}/flow.mdx`)).map((u)=>`flows/${u}/flow.mdx`),w=e.exists(".git"),T=w?e.read(".git/config"):void 0,E=T!==void 0&&T.includes("github.com")||e.exists(".github"),j=z(i,"workspaces"),U=[...e.exists("pnpm-workspace.yaml")?["pnpm-workspace.yaml"]:[],...Array.isArray(j)?["package.json#workspaces"]:[],...["packages","apps"].filter((u)=>e.list(u).length>0)],N=[...i===void 0?[]:["javascript"],...e.exists("tsconfig.json")?["typescript"]:[],...e.exists("Cargo.toml")?["rust"]:[],...e.exists("go.mod")?["go"]:[],...e.exists("pyproject.toml")?["python"]:[]];return{machine:n,checks:s,packageManager:r,scripts:t,testRunner:a,lint:d,ci:h,flows:m,packageFile:e.exists("PACKAGE.ts"),github:E,git:w,monorepo:U,agentsFile:q(e,["AGENTS.md","CLAUDE.md"]),changelog:q(e,["CHANGELOG.md",".changeset"]),language:N}};var Ve=[L.ci,L.incremental];var H=(e,i)=>{let t=Object.keys(i),n=(r)=>t.some((s)=>s.startsWith(`${r}/`));return{root:e,exists:(r)=>Object.hasOwn(i,r)||n(r),read:(r)=>Object.hasOwn(i,r)?i[r]:void 0,list:(r)=>[...new Set(t.filter((s)=>r===""||s.startsWith(`${r}/`)).map((s)=>s.slice(r===""?0:r.length+1).split("/")[0]))].sort()}};try{let e=JSON.parse(ae(0,"utf8")),i=K(H("/mirror",e)),t=process.argv[1]==="checks"?{tools:{},...i.checks.length===0?{}:{checks:i.checks}}:i.machine;if(t instanceof A)throw t;process.stdout.write(JSON.stringify({recipe:t}))}catch(e){if(!(e instanceof A))throw e;process.stdout.write(JSON.stringify({error:{code:e.code,class:e.class,message:e.message,fix:e.fix}}))}
