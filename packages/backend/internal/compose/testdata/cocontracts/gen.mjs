// Independent ADR 0004 byte tables. Never imports either production codec.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const check=process.argv.includes('--check');
const protocol=6;
const num=(v,n)=>{let b=Buffer.alloc(n);let x=BigInt(v);for(let i=n-1;i>=0;i--){b[i]=Number(x&255n);x>>=8n}return b};
const cat=(...b)=>Buffer.concat(b.map(x=>Buffer.from(x)));
const f=(t,b)=>cat([t],b);
const st=(...fields)=>{let b=cat(...fields);return cat(num(b.length,4),b)};
const un=(v,...fields)=>cat([v],st(...fields));
const str=s=>{let b=Buffer.from(s);return cat(num(b.length,2),b)};
const bytes=b=>cat(num(b.length,4),b);
const list=(...items)=>cat(num(items.length,2),...items);
const oid=Buffer.alloc(20,0x11),oid2=Buffer.alloc(20,0x22),digest=Buffer.alloc(32,0x33),id=Buffer.alloc(16,0x44);
const actor=un(1,f(1,bytes(Buffer.from('principal'))));
const base=un(1,f(1,digest));
const req=(method,...args)=>un(1,f(1,num(42,4)),f(2,un(method,...args)));
const res=(method,...args)=>un(2,f(1,num(42,4)),f(2,un(method,...args)));
const err=(code,...fields)=>res(255,f(1,[code]),...fields);
const entries=[];
function emit(name,kind,payload,stream=0,expected='ok',direction='host-to-daemon',local=false){const b=cat(num(payload.length,4),[kind],num(stream,4),payload);raw(name,b,expected,{kind,stream,payload:payload.toString('hex'),local},direction)}
function raw(name,b,expected,value=null,direction='host-to-daemon'){entries.push({name,b,expected,value,direction})}
emit('hello_challenge',0,un(1,f(1,num(0x534d4d44,4)),f(2,num(protocol,2)),f(3,id),f(4,digest)),0,'ok','daemon-to-host');
emit('hello_host_proof',0,un(2,f(1,num(protocol,2)),f(2,digest)));
emit('hello_machine',0,un(3,f(1,bytes(Buffer.from('boot-token'))),f(2,id),f(3,num(7,8)),f(4,list(num(1,4)))),0,'ok','daemon-to-host');
emit('hello_welcome',0,un(4));
for(const [name,code] of [['version_mismatch',13],['auth_failed',14],['superseded',15]])emit('goodbye_'+name,0,un(5,f(1,[code])));
const methods=['status','read_file','write_file','capture','wake_reconcile','open_session','tcp_connect','close_session','kill_sessions','register_run','rebase','return_to_item','open_doc','close_doc','attach_session'];
const args=[[],[f(1,str('src/a.ts'))],[f(1,str('src/a.ts')),f(2,base),f(3,bytes(Buffer.from('hello'))),f(4,actor)],[],[f(1,oid)],[f(1,st(f(1,str('ben')),f(2,num(20001,4)))),f(2,[1]),f(4,st(f(1,num(80,2)),f(2,num(24,2))))],[f(1,num(3000,2))],[f(1,num(1,4))],[f(1,un(1,f(1,st(f(1,str('ben')),f(2,num(20001,4))))))],[f(1,str('run-1')),f(2,num(1,4))],[f(1,oid),f(2,actor)],[f(1,actor)],[f(1,str('src/a.ts'))],[f(1,num(1,4))],[f(1,num(1,4)),f(2,num(65536,8))]];
for(let i=0;i<methods.length;i++){emit('req_'+methods[i],1,req(i+1,...args[i]));emit('res_unsupported_'+methods[i],1,err(2),0,'ok','daemon-to-host')}
emit('req_kill_sessions_user',1,req(9,...args[8]));emit('req_kill_sessions_run',1,req(9,f(1,un(2,f(1,str('run-1'))))));
emit('req_read_file_at',1,req(2,f(1,str('src/a.ts')),f(2,oid)));
emit('req_write_file_absent',1,req(3,f(1,str('src/new')),f(2,un(2)),f(3,bytes(Buffer.from('new'))),f(4,actor)));
emit('res_status',1,res(1,f(1,[3]),f(2,num(protocol,2)),f(3,str('0.1.0')),f(4,num(0,4)),f(5,oid),f(6,num(0,2))),0,'ok','daemon-to-host');
emit('res_read_file',1,res(2,f(1,bytes(Buffer.from('hello'))),f(2,digest),f(3,num(420,4))),0,'ok','daemon-to-host');
emit('res_write_file',1,res(3,f(1,digest)),0,'ok','daemon-to-host');
emit('res_capture',1,res(4,f(1,oid),f(2,oid2),f(3,num(0,2))),0,'ok','daemon-to-host');
for(const [v,name,fs] of [[1,'unchanged',[]],[2,'moved',[f(1,oid)]],[3,'conflict',[f(1,list(str('src/a.ts')))]]])emit('res_wake_'+name,1,res(5,f(1,un(v,...fs))),0,'ok','daemon-to-host');
for(const [code,name,fs] of [[3,'not_ready',[]],[4,'stale',[f(3,digest)]],[4,'stale_absent',[]],[5,'not_found',[f(7,list(oid))]],[6,'invalid_path',[]],[7,'not_regular',[]],[8,'too_large',[f(5,num(1048576,4))]],[9,'busy',[f(4,num(1,4))]],[10,'moved_off',[]],[11,'unauthorized',[]],[12,'internal',[f(2,str('fixture'))]],[1,'malformed_unknown_field',[f(6,[7])]]])emit('err_'+name,1,err(code,...fs),0,'ok','daemon-to-host');
const durable=(seq,event)=>un(1,f(1,num(seq,8)),f(2,id),f(3,event));
const bf=(path,change,...extra)=>st(f(1,str(path)),f(2,[change]),...extra);
emit('ev_burst',2,durable(7,un(1,f(1,id),f(2,actor),f(3,list(bf('src/a.ts',2,f(4,oid),f(5,oid2),f(6,digest)))),f(4,oid))),0,'ok','daemon-to-host');
emit('ev_burst_rename_delete',2,durable(8,un(1,f(1,id),f(2,un(2,f(1,num(1,4)))),f(3,list(bf('old',4,f(3,str('new')),f(4,oid),f(5,oid2),f(6,digest)),bf('gone',3,f(4,oid)))),f(4,oid))),0,'ok','daemon-to-host');
emit('ev_burst_part',2,durable(9,un(1,f(1,id),f(2,un(4)),f(3,list(bf('a',1,f(5,oid),f(6,digest)))),f(4,oid),f(5,num(1,2)),f(6,num(2,2)))),0,'ok','daemon-to-host');
emit('ev_captured',2,durable(8,un(2,f(1,oid),f(2,oid2),f(3,oid))),0,'ok','daemon-to-host');
for(const [v,name]of [[1,'moved'],[2,'conflict']])emit('ev_reconciled_'+name,2,durable(10,un(3,f(1,oid),f(2,oid2),f(3,[v]),...(v==2?[f(4,list(str('a')))]:[]))),0,'ok','daemon-to-host');
for(const [v,name]of [[4,'moved_off'],[5,'transcript'],[6,'doc_edit']])emit('ev_reserved_'+name,2,durable(11,un(v)),0,v===4||v===5?'missing_field':'ok','daemon-to-host');
// T-AGT-02 variant 5: wire version, registry session, participant, source lifetime,
// explicit adapter profile, generation, inclusive start/exclusive end, UTF-8 record.
const transcript=(text=Buffer.from('{"type":"user"}'),version=1)=>un(5,f(1,num(version,2)),f(2,num(1,4)),f(3,id),f(4,digest.subarray(0,16)),f(5,str('claude-code/2.1.0')),f(6,num(1,8)),f(7,num(0,8)),f(8,num(text.length+1,8)),f(9,bytes(text)));
emit('ev_transcript',2,durable(12,transcript()),0,'ok','daemon-to-host');
emit('ev_transcript_bad_utf8',2,durable(12,transcript(Buffer.from([255]))),0,'bad_utf8','daemon-to-host');
emit('ev_transcript_partial',2,durable(12,transcript(Buffer.from('one\ntwo'))),0,'bad_utf8','daemon-to-host');
emit('hint_file_written',2,un(2,f(1,un(1,f(1,str('a')),f(2,actor),f(3,digest)))),0,'ok','daemon-to-host');
emit('presence_snapshot',3,un(1,f(1,list(st(f(1,num(1,4)),f(2,str('a'))),st(f(1,num(2,4)))))),0,'ok','daemon-to-host');
for(const [v,name,fs]of [[1,'applied',[]],[2,'duplicate',[]],[3,'missing_objects',[f(3,list(oid)),f(5,list(oid2))]],[4,'rejected',[f(4,st(f(1,[11])))]],[5,'stale_base',[]]])emit('ack_'+name,2,un(3,f(1,num(7,8)),f(2,[v]),...fs));
for(const [name,p] of [['obj_data',cat([1,0],Buffer.from('git bundle fixture'))],['obj_eof',[2,0]],['obj_close',[7]],['obj_window',cat([6],num(65536,4))]])emit(name,6,Buffer.from(p),1,'ok','daemon-to-host');
emit('obj_host_data',6,cat([1,0],Buffer.from('git bundle fixture')),0x80000001);
emit('obj_host_eof',6,Buffer.from([2,0]),0x80000001);
emit('obj_host_close',6,Buffer.from([7]),0x80000001,'ok','daemon-to-host');
emit('ack_captured',2,un(3,f(1,num(8,8)),f(2,[1])));
for(const [name,p]of [['data_in',[1,0,97]],['data_out',[1,1,98]],['data_err',[1,2,99]],['eof',[2,1]],['resize',cat([3],num(80,2),num(24,2))],['signal_int',[4,1]],['exit_code',cat([5,0],num(0,4))],['exit_signal',[5,1,2,0]],['window',cat([6],num(262144,4))],['close',[7]],['refused_unsupported',un(255,f(1,[2]))]])emit('sess_'+name,5,Buffer.from(p),1);
emit('doc_reserved_sync',4,Buffer.from([1,9,8,7]),1);emit('doc_refused_unsupported',4,un(255,f(1,[2])),1);
emit('bad_unknown_field_uid',1,req(3,...args[2],f(9,num(20001,4))),0,'unknown_field');
emit('bad_actor_names_branch',1,req(3,...args[2].slice(0,3),f(4,un(1,f(1,bytes(Buffer.from('principal'))),f(2,str('branch'))))),0,'unknown_field');
emit('bad_actor_variant_from_host',1,req(3,...args[2].slice(0,3),f(4,un(4))),0,'bad_value');
emit('bad_unordered_field',1,req(2,f(2,oid),f(1,str('a'))),0,'unordered_field');
emit('bad_missing_field',1,req(2),0,'missing_field');
emit('bad_utf8_path',1,req(2,f(1,cat(num(1,2),[255]))),0,'bad_utf8');
emit('local_write_with_actor',1,req(3,...args[2]),0,'unknown_field','local',true);
emit('local_write_without_actor',1,req(3,...args[2].slice(0,3)),0,'ok','local',true);
raw('bad_truncated_header',Buffer.from([0,0]),'truncated');
raw('bad_truncated_payload',cat(num(4,4),[1],num(0,4),[1]),'truncated');
raw('bad_oversized_control',cat(num(1114113,4),[1],num(0,4)),'frame_too_large');
raw('bad_unknown_kind',cat(num(0,4),[99],num(0,4)),'unknown_kind');
raw('bad_stream_on_control',cat(num(0,4),[1],num(1,4)),'bad_stream');
raw('bad_trailing_bytes',cat(num(5,4),[0],num(0,4),un(4),[0]),'trailing_bytes');
for(const [n,name,expected] of [[1048576,'content_at_limit','ok'],[1048577,'content_over_limit','bad_value']])emit(name,1,req(3,f(1,str('a')),f(2,un(2)),f(3,bytes(Buffer.alloc(n,97))),f(4,actor)),0,expected);
// S3 document fixtures are literal tables, independent of either codec.
const docs=JSON.parse(readFileSync(dir+'doc-daemon.json','utf8'));
for(const d of docs.frames){const b=Buffer.from(d.hex,'hex');raw('doc-'+d.name,b,'ok',{kind:4,stream:9,payload:b.subarray(9).toString('hex'),local:false},d.msg===1||d.msg===2?'host-to-daemon':'daemon-to-host')}
emit('req_open_doc_s3',1,req(13,f(1,str('retry.ts')),f(2,un(1,f(1,bytes(Buffer.from('Be')))))));
emit('req_close_doc_s3',1,un(1,f(1,num(43,4)),f(2,un(14,f(1,num(9,4))))));
// Working-together I1: protocol 2 document bodies; all old tables stay byte-identical.
emit('hello_challenge_v2',0,un(1,f(1,num(0x534d4d44,4)),f(2,num(2,2)),f(3,id),f(4,digest)),0,'ok','daemon-to-host');
emit('hello_host_proof_v2',0,un(2,f(1,num(2,2)),f(2,digest)));
const sequence=0x0102030405060708n;
emit('doc-input-v2',4,cat([1],un(1,f(1,bytes(Buffer.from('Be')))),num(sequence,8),[0,2,0]),9);
emit('doc-saved-v2',4,cat([6],num(1791028800000,8),num(sequence,8),[1,42,1]),9,'ok','daemon-to-host');
emit('doc-input-v2-zero',4,cat([1],un(1,f(1,bytes(Buffer.from('Be')))),num(0,8),[0,2,0]),9);
emit('doc-saved-v2-max',4,cat([6],num(1791028800000,8),num(0xffffffffffffffffn,8),[1,42,1]),9,'ok','daemon-to-host');
emit('req_set_roster',1,req(16,f(1,list(st(f(1,str('ben')),f(2,num(20001,4))),st(f(1,str('will')),f(2,num(20002,4)))))));
emit('req_set_roster_empty',1,req(16,f(1,list())));
emit('res_set_roster',1,res(16),0,'ok','daemon-to-host');
emit('res_write_file_raced',1,res(3,f(1,digest),f(2,st(f(1,str('src/a.ts')),f(2,Buffer.alloc(32,0x55))))),0,'ok','daemon-to-host');
emit('bad_roster_missing_uid',1,req(16,f(1,list(st(f(1,str('ben')))))),0,'missing_field');
emit('bad_raced_missing_digest',1,res(3,f(1,digest),f(2,st(f(1,str('src/a.ts'))))),0,'missing_field','daemon-to-host');
// Variant 4 moved_off (#3562): session actor 7, TODO item 2, pre-move commit.
emit('ev_moved_off',2,durable(11,un(4,f(1,un(2,f(1,num(7,4)))),f(2,num(2,8)),f(3,Buffer.from('1234567890abcdef1234567890abcdef12345678','hex')))),0,'ok','daemon-to-host');
// Protocol 6: compare the whole text batch before mutation. Literal tables
// remain independent of both production encoders.
const batchActor=un(1,f(1,bytes(Buffer.from(Array.from({length:16},(_,i)=>i+1)))));
const sha=b=>createHash('sha256').update(b).digest();
const batchChanges=list(st(f(1,str('a')),f(2,un(2)),f(3,bytes(Buffer.from('x')))),st(f(1,str('b')),f(2,un(1,f(1,sha('before')))),f(3,bytes(Buffer.from('y')))));
const batchReq=(...fs)=>un(1,f(1,num(9,4)),f(2,un(17,...fs)));
const batchRes=(...fs)=>un(2,f(1,num(9,4)),f(2,un(17,...fs)));
const batchReceipt=st(f(1,sha('x')));
const batchFailure=(index,preflight,code)=>st(f(1,num(index,2)),f(2,[preflight]),f(3,st(f(1,[code]))));
emit('req_write_files',1,batchReq(f(1,batchChanges),f(2,batchActor)));
emit('local_write_files',1,batchReq(f(1,batchChanges)),0,'ok','host-to-daemon',true);
emit('local_write_files_actor',1,batchReq(f(1,batchChanges),f(2,batchActor)),0,'unknown_field','host-to-daemon',true);
emit('res_write_files',1,batchRes(f(1,list(batchReceipt,st(f(1,sha('y')))))),0,'ok','daemon-to-host');
emit('res_write_files_stale',1,batchRes(f(1,list()),f(2,batchFailure(1,1,4))),0,'ok','daemon-to-host');
emit('res_write_files_partial',1,batchRes(f(1,list(batchReceipt)),f(2,batchFailure(1,0,12))),0,'ok','daemon-to-host');
const previous=JSON.parse(readFileSync(dir+'MANIFEST.json','utf8'));
const manifest={...previous,scope:"ADR 0004 daemon contract and T-COL-08b browser fixtures",document_protocol:2,protocol,legacy_protocols:[],pins:{...previous.pins,yrs:'=0.27.4'},frames:entries.map(e=>({name:e.name,direction:e.direction,expected:e.expected,local:e.value?.local??false,sha256:createHash('sha256').update(e.b).digest('hex')})),sequences:{seq_working_together:['req_set_roster','res_set_roster','req_open_doc_s3','doc-epoch','doc-input-v2','doc-saved-v2','req_write_file','res_write_file_raced','req_set_roster_empty','res_set_roster'],seq_handshake:['hello_challenge','hello_host_proof','hello_machine','hello_welcome'],seq_write_stale:['req_write_file','err_stale'],seq_capture:['obj_data','obj_eof','ev_captured','ack_captured'],seq_missing_objects:['ack_missing_objects','obj_data','obj_eof','ev_burst','ack_applied'],seq_duplicate_receipt:['ev_burst','ack_duplicate'],seq_reconnect_replay:['hello_challenge','hello_host_proof','hello_machine','hello_welcome','ev_burst','ev_captured'],seq_reserved_doc_s2:['doc_reserved_sync','doc_refused_unsupported'],seq_newer_boot:['goodbye_superseded'],seq_wake_objects:['obj_host_data','obj_host_eof','obj_host_close','req_wake_reconcile']}};
function save(name,bytes){if(check){if(!readFileSync(dir+name).equals(Buffer.from(bytes)))throw Error('fixture drift: '+name)}else writeFileSync(dir+name,bytes)}
for(const e of entries){save(e.name+'.bin',e.b);save(e.name+'.json',JSON.stringify(e.value??{expected:e.expected},null,2)+'\n')}
save('MANIFEST.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`${entries.length} golden frames ${check?'verified':'written'}`);
