/** Source inserted into the existing exact-model reviewer, never a second seat. */
import { parseAcceptanceReview, validateAcceptance } from "./acceptance.ts"
import { validateLandingReceipt, validateMemberAcceptance } from "./landing-receipt.ts"
import { buildReviewInput, ReviewInputIncomplete } from "./review-input.ts"

export const acceptanceReviewPrelude = (includeHelpers = true) =>
  String.raw`
import { readFileSync, statSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname as acceptanceDirname } from "node:path";
${validateAcceptance.toString()}
${parseAcceptanceReview.toString()}
${
    includeHelpers
      ? "const ReviewInputIncomplete = " + ReviewInputIncomplete.toString() + ";\n" + buildReviewInput.toString()
      : ""
  }
const acceptanceMember = JSON.parse(readFileSync(process.env.BURNDOWN_ACCEPTANCE_MEMBER_PATH,"utf8"));
const acceptancePath = process.env.BURNDOWN_ACCEPTANCE_PATH;
console.log("REVIEW_RANGE "+JSON.stringify({revision:sha,base:typeof reviewBase==="undefined"?"main@origin":reviewBase,scope:typeof reviewBaseSelector!=="undefined"&&reviewBaseSelector!=="main@origin"?"historical superset including intervening commits":"final rebased candidate"}));
if (!acceptancePath || acceptanceMember.commits.length === 0) throw new Error("ACCEPTANCE_INPUT_MISSING");
const issueData = acceptanceMember.commits.map(({issue}) => {
  let raw;
  try { raw = execFileSync("gh", ["issue", "view", String(issue), "--repo", acceptanceMember.repo, "--json", "number,title,body,comments"], {encoding:"utf8",timeout:Math.min(60_000,remaining()),maxBuffer:16<<20}); }
  catch (error) { if(error.code==="ENOBUFS") throw new ReviewInputIncomplete("issue_capture_limit",Buffer.byteLength(error.stdout??""),16<<20,{revision:sha,base:typeof reviewBase==="undefined"?"main@origin":reviewBase}); throw error; }
  const data = JSON.parse(raw);
  if (data.number !== issue || typeof data.body !== "string" || typeof data.title !== "string" || !Array.isArray(data.comments)) throw new Error("ACCEPTANCE_ISSUE_INVALID");
  return data;
});
const readChecks = (path, field) => {
  const size = statSync(path).size;
  if (size > 1_048_576) throw new ReviewInputIncomplete(field, size,1_048_576,{revision:sha,base:typeof reviewBase==="undefined"?"main@origin":reviewBase});
  const text = readFileSync(path,"utf8");
  if (Buffer.byteLength(text) > 1_048_576) throw new ReviewInputIncomplete(field, Buffer.byteLength(text),1_048_576,{revision:sha,base:typeof reviewBase==="undefined"?"main@origin":reviewBase});
  return text;
};
const acceptanceContext = {
  repo: acceptanceMember.repo, revision: sha, commits: acceptanceMember.commits,
  issues: issueData.map(data => ({issue:data.number,body:data.title+"\n"+data.body})),
  checks: readChecks(process.env.BURNDOWN_PRECHECKS_LOG,"prechecks_input_limit")+"\n"+readChecks(process.env.BURNDOWN_CHECKS_LOG,"checks_input_limit")
};
if (!acceptanceContext.checks.includes("CHECK_REVISION "+sha) || !acceptanceContext.checks.includes("CHECKS_PASSED")) throw new Error("ACCEPTANCE_CHECKS_MISSING");
const reviewInput = buildReviewInput({
  revision:sha,
  base:typeof reviewBase === "undefined" ? "main@origin" : reviewBase,
  historical:typeof reviewBaseSelector === "undefined" ? false : reviewBaseSelector !== "main@origin",
  diff:typeof diff === "undefined" ? "" : diff,
  context:acceptanceContext,
  comments:issueData.map(data => ({issue:data.number,comments:data.comments})),
  notes:acceptanceMember.notes??""
});
const acceptancePrompt = reviewInput.input;
console.log("REVIEW_INPUT_RECEIPT "+JSON.stringify(reviewInput.receipt));
const saveAcceptance = report => {
  const record = {...parseAcceptanceReview(report, acceptanceContext),reviewInput:reviewInput.receipt};
  for (const item of record.receipt.issues) for (const pending of item.remaining) {
    const [repo,number] = pending.issue.split("#");
    const linked = JSON.parse(execFileSync("gh",["issue","view",number,"--repo",repo,"--json","number"],{encoding:"utf8",timeout:Math.min(60_000,remaining()),maxBuffer:1<<20}));
    if (String(linked.number)!==number) throw new Error("ACCEPTANCE_REMAINDER_INVALID");
  }
  const temporary = acceptancePath+".pending";
  writeFileSync(temporary, JSON.stringify(record)+"\n",{mode:0o600});
  const fd = openSync(temporary,"r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary,acceptancePath);
  const directoryFd=openSync(acceptanceDirname(acceptancePath),"r"); try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
};
`

/** Runs after confirmed push, before checkout realignment or issue writes. */
export const pushedReceiptProgram = () =>
  String.raw`
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname as acceptanceDirname } from "node:path";
${validateAcceptance.toString()}
const [path,acceptancePath,memberPath,revision,...changes] = process.argv.slice(1);
const member = JSON.parse(readFileSync(memberPath,"utf8"));
${validateMemberAcceptance.toString()}
${validateLandingReceipt.toString()}
if (changes.length!==member.commits.length) throw new Error("PUSHED_RECEIPT_INVALID");
const landed = changes.map((change,index) => ({issue:member.commits[index].issue,sha:execFileSync("jj",["--ignore-working-copy","log","--no-graph","-r",change,"-T","commit_id"],{encoding:"utf8",timeout:60_000}).trim()}));
if (landed.at(-1)?.sha!==revision) throw new Error("PUSHED_RECEIPT_INVALID");
const fact = validateLandingReceipt({version:2,phase:"landed",key:member.key,repo:member.repo,commits:member.commits,landed},member);
let prior;
try { prior=validateLandingReceipt(JSON.parse(readFileSync(path,"utf8")),member); }
catch(error) { if(error.code!=="ENOENT") throw error; }
const retained = member.expectedReceipt===undefined?undefined:validateLandingReceipt(member.expectedReceipt,member);
for(const expected of [prior,retained]) {
  if(expected!==undefined && JSON.stringify(expected.landed)!==JSON.stringify(landed)) throw new Error("PUSHED_RECEIPT_REMOTE_MISMATCH");
}
if(acceptancePath==="-verify") process.exit(0);
console.log("LANDING_CONFIRMED "+JSON.stringify(fact));
const record = acceptancePath === "-" ? undefined : JSON.parse(readFileSync(acceptancePath,"utf8"));
const saved = record === undefined ? (prior??retained??fact) : validateLandingReceipt({...fact,phase:"verified",acceptance:record},member);
const temporary=path+".pending";
writeFileSync(temporary,JSON.stringify(saved)+"\n",{mode:0o600});
const fd=openSync(temporary,"r"); try{fsyncSync(fd);}finally{closeSync(fd);}
renameSync(temporary,path);
const directoryFd=openSync(acceptanceDirname(path),"r"); try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
`

/** A read-only probe lets embedded verified evidence survive standalone-file loss. */
export const verifiedReceiptProgram = () =>
  String.raw`
import {readFileSync} from "node:fs";
${validateAcceptance.toString()}
${validateMemberAcceptance.toString()}
${validateLandingReceipt.toString()}
try {
  const [path,memberPath]=process.argv.slice(1);
  const saved=validateLandingReceipt(JSON.parse(readFileSync(path,"utf8")),JSON.parse(readFileSync(memberPath,"utf8")));
  if(saved.version!==1 && saved.phase!=="verified") process.exit(1);
} catch {process.exit(1);}
`
