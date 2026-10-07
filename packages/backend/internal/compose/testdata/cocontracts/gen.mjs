// Independent ADR 0004 byte tables. Never imports either production codec.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('.',import.meta.url));
const check=process.argv.includes('--check');
const protocol=7;
// ADR 0004 §handshake: one protocol value in four places, changed in one
// commit. This reads the other three as text (it imports no codec) and fails
// both --check and generation when any differs.
const repo=dir+'../../../../../../';
for(const [file,re] of [['docs/architecture/0004-machined-wire.md',/^`protocol` is `(\d+)`/m],['packages/backend/internal/machined/wire/frame.go',/^const Protocol = (\d+)$/m],['crates/smithers-machined/src/conn.rs',/^pub const PROTOCOL: u16 = (\d+);$/m]]){const m=readFileSync(repo+file,'utf8').match(re);if(!m||Number(m[1])!==protocol)throw Error(`protocol drift: ${file} says ${m?.[1]}, gen.mjs ${protocol}`)}
// Every builder also records a structured literal (ADR 0004 golden frames:
// the .json `literal`), so a reviewer reads field values without decoding.
// Field tags are numbers: names would need a schema, i.e. a third codec.
const L=new WeakMap();const lit=(b,v)=>(L.set(b,v),b);
const leaf=b=>L.get(b)??(Array.isArray(b)&&b.length===1?{u8:b[0]}:{hex:Buffer.from(b).toString('hex')});
const sha256=b=>createHash('sha256').update(b).digest('hex');
const num=(v,n)=>{let b=Buffer.alloc(n);let x=BigInt(v);for(let i=n-1;i>=0;i--){b[i]=Number(x&255n);x>>=8n}return lit(b,{['u'+n*8]:BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER)?BigInt(v).toString():Number(v)})};
const cat=(...b)=>Buffer.concat(b.map(x=>Buffer.from(x)));
const f=(t,b)=>lit(cat([t],b),[t,leaf(b)]);
const st=(...fields)=>{let b=cat(...fields);return lit(cat(num(b.length,4),b),{struct:fields.map(leaf)})};
const un=(v,...fields)=>lit(cat([v],st(...fields)),{variant:v,struct:fields.map(leaf)});
const str=s=>{let b=Buffer.from(s);return lit(cat(num(b.length,2),b),{str:s})};
const bytes=b=>lit(cat(num(b.length,4),b),b.length<=64?{bytes:Buffer.from(b).toString('hex')}:{bytes_len:b.length,sha256:sha256(b)});
const list=(...items)=>lit(cat(num(items.length,2),...items),{list:items.map(leaf)});
const oid=Buffer.alloc(20,0x11),oid2=Buffer.alloc(20,0x22),digest=Buffer.alloc(32,0x33),id=Buffer.alloc(16,0x44);
const actor=un(1,f(1,bytes(Buffer.from('principal'))));
const base=un(1,f(1,digest));
const req=(method,...args)=>un(1,f(1,num(42,4)),f(2,un(method,...args)));
const res=(method,...args)=>un(2,f(1,num(42,4)),f(2,un(method,...args)));
const err=(code,...fields)=>res(255,f(1,[code]),...fields);
// HostProof vectors (ADR 0004 ruling 1). mac literals were computed with
// Python's hmac and cross-checked with `openssl dgst -sha256 -mac HMAC`, never
// with either codec: HMAC-SHA256(secret, "smithers-machined host" ||
// u16 BE protocol || boot_id || nonce). A protocol bump recomputes them here;
// the createHmac line is a third, independent check.
const MAC_LABEL='smithers-machined host';
const range=(a,b)=>Buffer.from(Array.from({length:b-a},(_,i)=>a+i));
const vectors={
  a:{secret:range(0x00,0x20),boot_id:range(0xa0,0xb0),nonce:range(0x20,0x40),mac:'bf835b8b735a29000a5b1db8369ec694b8b8fa8f786ed931ff4dfc06be3566f4'},
  b:{secret:range(0x40,0x60),boot_id:range(0xb0,0xc0),nonce:range(0x60,0x80),mac:'c6fc90e2834fdc3176329238a8033b9a354b0b03d36036b7e12f5e164371e837'},
  // c: b's boot and secret, a fresh nonce (seq_newer_boot's third connection).
  c:{secret:range(0x40,0x60),boot_id:range(0xb0,0xc0),nonce:range(0x80,0xa0),mac:'f68cb22bfc24ddae7be2ca31d46e166a703fe7ea73f48675fd62558633549af1'},
};
const macInput=v=>cat(Buffer.from(MAC_LABEL),num(protocol,2),v.boot_id,v.nonce);
for(const [name,v] of Object.entries(vectors))if(createHmac('sha256',v.secret).update(macInput(v)).digest('hex')!==v.mac)throw Error('HMAC vector '+name+' disagrees with node:crypto');
const mac=v=>Buffer.from(v.mac,'hex');
const badMac=Buffer.from(mac(vectors.a));badMac[31]^=1;
const eid=n=>Buffer.alloc(16,n);
const entries=[];
function emit(name,kind,payload,stream=0,expected='ok',direction='host-to-daemon',local=false){const b=cat(num(payload.length,4),[kind],num(stream,4),payload);raw(name,b,expected,{kind,stream,payload:payload.toString('hex'),local,...(L.has(payload)?{literal:L.get(payload)}:{})},direction)}
function raw(name,b,expected,value=null,direction='host-to-daemon',extra={}){entries.push({name,b,expected,value,direction,extra})}
const header=(n,kind,stream=0)=>cat(num(n,4),[kind],num(stream,4));
const challenge=(v,p=protocol)=>un(1,f(1,num(0x534d4d44,4)),f(2,num(p,2)),f(3,v.boot_id),f(4,v.nonce));
const proof=(m,p=protocol)=>un(2,f(1,num(p,2)),f(2,m));
// `vector` names the challenge a proof answers; `handshake` is the outcome a
// production handshake must reach when decoding alone accepts the frame.
function hello(name,payload,expected,direction,vector,handshake){emit(name,0,payload,0,expected,direction);entries.at(-1).extra=handshake?{vector,handshake}:{vector}}
hello('hello_challenge',challenge(vectors.a),'ok','daemon-to-host','a');
hello('hello_host_proof',proof(mac(vectors.a)),'ok','host-to-daemon','a');
// Decodes, but the mac is not HMAC(a): the daemon answers auth_failed.
hello('hello_host_proof_bad_mac',proof(badMac),'ok','host-to-daemon','a','auth_failed');
// Exactly one live protocol. An older one still decodes (recorded history) and
// is refused by the handshake; a newer one is refused by the decoder. The
// proofs carry a's current mac, wrong for their protocol, so version_mismatch
// shows the version check precedes the MAC.
for(const [p,name] of [[protocol-1,'older'],[protocol+1,'newer']]){const older=p<protocol;hello('hello_challenge_'+name,challenge(vectors.a,p),older?'ok':'version_mismatch','daemon-to-host','a',older?'version_mismatch':undefined);hello('hello_host_proof_'+name,proof(mac(vectors.a),p),older?'ok':'version_mismatch','host-to-daemon','a',older?'version_mismatch':undefined)}
// Connection b: the same machine's newer boot (seq_newer_boot).
hello('hello_challenge_b',challenge(vectors.b),'ok','daemon-to-host','b');
hello('hello_host_proof_b',proof(mac(vectors.b)),'ok','host-to-daemon','b');
hello('hello_challenge_c',challenge(vectors.c),'ok','daemon-to-host','c');
hello('hello_host_proof_c',proof(mac(vectors.c)),'ok','host-to-daemon','c');
emit('hello_machine',0,un(3,f(1,bytes(Buffer.from('boot-token'))),f(2,id),f(3,num(7,8)),f(4,list(num(1,4)))),0,'ok','daemon-to-host');
emit('hello_machine_b',0,un(3,f(1,bytes(Buffer.from('boot-token-2'))),f(2,Buffer.alloc(16,0x45)),f(3,num(1,8)),f(4,list())),0,'ok','daemon-to-host');
emit('hello_welcome',0,un(4));
for(const [name,code] of [['version_mismatch',13],['auth_failed',14],['superseded',15],['handshake_order',16]])emit('goodbye_'+name,0,un(5,f(1,[code])));
// Goodbye's optional detail (ADR §handshake, at most 1,024 bytes).
emit('goodbye_detail',0,un(5,f(1,[14]),f(2,str('credential belongs to another boot'))));
const methods=['status','read_file','write_file','capture','wake_reconcile','open_session','tcp_connect','close_session','kill_sessions','register_run','rebase','return_to_item','open_doc','close_doc','attach_session'];
const args=[[],[f(1,str('src/a.ts'))],[f(1,str('src/a.ts')),f(2,base),f(3,bytes(Buffer.from('hello'))),f(4,actor)],[],[f(1,oid)],[f(1,st(f(1,str('ben')),f(2,num(20001,4)))),f(2,[1]),f(4,st(f(1,num(80,2)),f(2,num(24,2))))],[f(1,num(3000,2))],[f(1,num(1,4))],[f(1,un(1,f(1,st(f(1,str('ben')),f(2,num(20001,4))))))],[f(1,str('run-1')),f(2,num(1,4))],[f(1,oid),f(2,actor)],[f(1,actor)],[f(1,str('src/a.ts'))],[f(1,num(1,4))],[f(1,num(1,4)),f(2,num(65536,8))]];
for(let i=0;i<methods.length;i++){emit('req_'+methods[i],1,methods[i]==='kill_sessions'?req(9,f(1,un(3,f(1,num(1,4))))):req(i+1,...args[i]));emit('res_unsupported_'+methods[i],1,err(2),0,'ok','daemon-to-host')}
emit('req_kill_sessions_user',1,req(9,...args[8]));emit('req_kill_sessions_run',1,req(9,f(1,un(2,f(1,str('run-1'))))));
emit('req_read_file_at',1,req(2,f(1,str('src/a.ts')),f(2,oid)));
emit('req_write_file_absent',1,req(3,f(1,str('src/new')),f(2,un(2)),f(3,bytes(Buffer.from('new'))),f(4,actor)));
// Protocol 3 admission: open_session tags 5/6, tcp_connect tags 2/3. The
// local socket decodes the same fields and the daemon refuses them there.
const agent=st(f(1,str('agent')),f(2,num(19999,4))),committed=Buffer.alloc(16,0x77);
emit('req_open_session_admitted',1,req(6,f(1,agent),f(2,[1]),f(4,st(f(1,num(80,2)),f(2,num(24,2)))),f(5,committed),f(6,str('run-1'))));
emit('req_tcp_connect_admitted',1,req(7,f(1,num(3000,2)),f(2,committed),f(3,str('run-1'))));
emit('local_open_session',1,req(6,f(1,agent),f(2,[1])),0,'ok','host-to-daemon',true);
emit('local_open_session_admitted',1,req(6,f(1,agent),f(2,[1]),f(5,committed),f(6,str('run-1'))),0,'ok','host-to-daemon',true);
// Protocol 4: kill_sessions result `killed`; 0 for an already reaped id.
for(const [name,n] of [['res_kill_sessions',1],['res_kill_sessions_none',0]])emit(name,1,res(9,f(1,num(n,2))),0,'ok','daemon-to-host');
emit('res_status',1,res(1,f(1,[3]),f(2,num(protocol,2)),f(3,str('0.1.0')),f(4,num(0,4)),f(5,oid),f(6,num(0,2))),0,'ok','daemon-to-host');
// acked_head is optional: absent before the first acknowledged capture.
emit('res_status_no_acked_head',1,res(1,f(1,[2]),f(2,num(protocol,2)),f(3,str('0.1.0')),f(4,num(3,4)),f(6,num(0,2))),0,'ok','daemon-to-host');
emit('res_read_file',1,res(2,f(1,bytes(Buffer.from('hello'))),f(2,digest),f(3,num(420,4))),0,'ok','daemon-to-host');
emit('res_write_file',1,res(3,f(1,digest)),0,'ok','daemon-to-host');
emit('res_capture',1,res(4,f(1,oid),f(2,oid2),f(3,num(0,2))),0,'ok','daemon-to-host');
for(const [v,name,fs] of [[1,'unchanged',[]],[2,'moved',[f(1,oid)]],[3,'conflict',[f(1,list(str('src/a.ts')))]]])emit('res_wake_'+name,1,res(5,f(1,un(v,...fs))),0,'ok','daemon-to-host');
for(const [code,name,fs] of [[3,'not_ready',[]],[4,'stale',[f(3,digest)]],[4,'stale_absent',[]],[5,'not_found',[f(7,list(oid))]],[6,'invalid_path',[]],[7,'not_regular',[]],[8,'too_large',[f(5,num(1048576,4))]],[9,'busy',[f(4,num(1,4))]],[10,'moved_off',[]],[11,'unauthorized',[]],[12,'internal',[f(2,str('fixture'))]],[1,'malformed_unknown_field',[f(6,[7])]]])emit('err_'+name,1,err(code,...fs),0,'ok','daemon-to-host');
const durable=(seq,event,eventId)=>un(1,f(1,num(seq,8)),f(2,eventId),f(3,event));
const bf=(path,change,...extra)=>st(f(1,str(path)),f(2,[change]),...extra);
emit('ev_burst',2,durable(7,un(1,f(1,id),f(2,actor),f(3,list(bf('src/a.ts',2,f(4,oid),f(5,oid2),f(6,digest)))),f(4,oid)),eid(0xe1)),0,'ok','daemon-to-host');
emit('ev_burst_rename_delete',2,durable(8,un(1,f(1,id),f(2,un(2,f(1,num(1,4)))),f(3,list(bf('old',4,f(3,str('new')),f(4,oid),f(5,oid2),f(6,digest)),bf('gone',3,f(4,oid)))),f(4,oid)),eid(0xe2)),0,'ok','daemon-to-host');
emit('ev_burst_part',2,durable(9,un(1,f(1,id),f(2,un(4)),f(3,list(bf('a',1,f(5,oid),f(6,digest)))),f(4,oid),f(5,num(1,2)),f(6,num(2,2))),eid(0xe3)),0,'ok','daemon-to-host');
emit('ev_captured',2,durable(8,un(2,f(1,oid),f(2,oid2),f(3,Buffer.alloc(20,0x66))),eid(0xe4)),0,'ok','daemon-to-host');
for(const [v,name]of [[1,'moved'],[2,'conflict']])emit('ev_reconciled_'+name,2,durable(10,un(3,f(1,oid),f(2,oid2),f(3,[v]),...(v==2?[f(4,list(str('a')))]:[])),eid(0xe4+v)),0,'ok','daemon-to-host');
// Variant 4 is defined (moved_off): an empty body lacks its required fields.
emit('ev_reserved_moved_off',2,durable(11,un(4),eid(0xe7)),0,'missing_field','daemon-to-host');
// ADR 0004 ruling 3: a reserved variant is bad_value before its body is decoded.
emit('ev_reserved_doc_edit',2,durable(11,un(6),eid(0xe8)),0,'bad_value','daemon-to-host');
emit('ev_reserved_doc_edit_body',2,durable(11,un(6,f(1,num(1,4)),f(2,str('a'))),eid(0xe9)),0,'bad_value','daemon-to-host');
// Variant 5 transcript (ADR 0004 ruling 2, #3622). Tag 9 carries the record
// with a u32 length, as both live codecs encode it (the ruling's text says
// `str`; see #3626). ev_transcript's bytes are the ones T-AGT-02 shipped.
const transcript=({version=1,session=1,participant=id,source=Buffer.alloc(16,0x33),profile='claude-code/2.1.0',generation=1,record=Buffer.from('{"type":"user"}'),start=0,end}={})=>un(5,f(1,num(version,2)),f(2,num(session,4)),f(3,participant),f(4,source),f(5,str(profile)),f(6,num(generation,8)),f(7,num(start,8)),f(8,num(end??start+record.length+1,8)),f(9,bytes(record)));
emit('ev_transcript',2,durable(12,transcript(),id),0,'ok','daemon-to-host');
// Invalid UTF-8 in the record is the str rule (bad_utf8); a newline inside it
// breaks "one record without its newline" (bad_value).
emit('ev_transcript_bad_utf8',2,durable(12,transcript({record:Buffer.from([255])}),eid(0xf0)),0,'bad_utf8','daemon-to-host');
emit('ev_transcript_partial',2,durable(12,transcript({record:Buffer.from('one\ntwo')}),eid(0xf1)),0,'bad_value','daemon-to-host');
// One violated bound each; every other field is ev_transcript's.
for(const [i,[name,change]] of Object.entries({version:{version:2},session_zero:{session:0},session_over:{session:0x80000000},participant_zero:{participant:Buffer.alloc(16)},source_zero:{source:Buffer.alloc(16)},profile_empty:{profile:''},generation_zero:{generation:0},end_not_after_start:{start:16,end:16},span:{end:17}}).entries())emit('bad_value_transcript_'+name,2,durable(12,transcript(change),eid(0xf2+i)),0,'bad_value','daemon-to-host');
// Ruling 2's record bounds (8a at 02fe2e50a2): 1 byte to 1 MiB, UTF-8 without
// NUL. Each span is valid, so each frame violates only its named bound.
emit('bad_value_transcript_record_empty',2,durable(12,transcript({record:Buffer.alloc(0)}),eid(0xd0)),0,'bad_value','daemon-to-host');
emit('ev_transcript_record_at_limit',2,durable(12,transcript({record:Buffer.alloc(1048576,0x61)}),eid(0xd1)),0,'ok','daemon-to-host');
emit('bad_value_transcript_record_over_1mib',2,durable(12,transcript({record:Buffer.alloc(1048577,0x61)}),eid(0xd2)),0,'bad_value','daemon-to-host');
emit('ev_transcript_bad_utf8_nul',2,durable(12,transcript({record:Buffer.from('a\0b')}),eid(0xd3)),0,'bad_utf8','daemon-to-host');
emit('hint_file_written',2,un(2,f(1,un(1,f(1,str('a')),f(2,actor),f(3,digest)))),0,'ok','daemon-to-host');
emit('presence_snapshot',3,un(1,f(1,list(st(f(1,num(1,4)),f(2,str('a'))),st(f(1,num(2,4)))))),0,'ok','daemon-to-host');
for(const [v,name,fs]of [[1,'applied',[]],[2,'duplicate',[]],[3,'missing_objects',[f(3,list(oid)),f(5,list(oid2))]],[4,'rejected',[f(4,st(f(1,[11])))]],[5,'stale_base',[]]])emit('ack_'+name,2,un(3,f(1,num(7,8)),f(2,[v]),...fs));
// Stream 1 is the daemon's bundle; the host returns its credit (window).
for(const [name,p] of [['obj_data',cat([1,0],Buffer.from('git bundle fixture'))],['obj_eof',[2,0]],['obj_close',[7]],['obj_window',cat([6],num(65536,4))]])emit(name,6,Buffer.from(p),1,'ok',name==='obj_window'?'host-to-daemon':'daemon-to-host');
for(const [prefix,stream] of [['obj_resend_',2],['obj_replay_',3]]){emit(prefix+'data',6,cat([1,0],Buffer.from('git bundle fixture')),stream,'ok','daemon-to-host');emit(prefix+'eof',6,Buffer.from([2,0]),stream,'ok','daemon-to-host')}
emit('obj_host_data',6,cat([1,0],Buffer.from('git bundle fixture')),0x80000001);
emit('obj_host_eof',6,Buffer.from([2,0]),0x80000001);
emit('obj_host_close',6,Buffer.from([7]),0x80000001,'ok','daemon-to-host');
emit('ack_captured',2,un(3,f(1,num(8,8)),f(2,[1])));
for(const [name,p]of [['data_in',[1,0,97]],['data_out',[1,1,98]],['data_err',[1,2,99]],['eof',[2,1]],['resize',cat([3],num(80,2),num(24,2))],['signal_int',[4,1]],['exit_code',cat([5,0],num(0,4))],['exit_signal',[5,1,2,0]],['window',cat([6],num(262144,4))],['close',[7]],['refused_unsupported',un(255,f(1,[2]))]]){const daemon=['data_out','data_err','eof','exit_code','exit_signal','refused_unsupported'].includes(name);emit('sess_'+name,5,Buffer.from(p),1,'ok',daemon?'daemon-to-host':'host-to-daemon')}
// Opaque to the envelope decoder in every stage, and a well-formed protocol-2
// input sync (actor, seq, sync bytes), so it misleads no S3 reader.
emit('doc_reserved_sync',4,cat([1],un(1,f(1,bytes(Buffer.from('Be')))),num(1,8),[0,2,0]),1);emit('doc_refused_unsupported',4,un(255,f(1,[2])),1,'ok','daemon-to-host');
emit('bad_unknown_field_uid',1,req(3,...args[2],f(9,num(20001,4))),0,'unknown_field');
emit('bad_actor_names_branch',1,req(3,...args[2].slice(0,3),f(4,un(1,f(1,bytes(Buffer.from('principal'))),f(2,str('branch'))))),0,'unknown_field');
emit('bad_actor_variant_from_host',1,req(3,...args[2].slice(0,3),f(4,un(4))),0,'bad_value');
emit('bad_unordered_field',1,req(2,f(2,oid),f(1,str('a'))),0,'unordered_field');
emit('bad_missing_field',1,req(2),0,'missing_field');
emit('bad_utf8_path',1,req(2,f(1,cat(num(1,2),[255]))),0,'bad_utf8');
emit('local_write_with_actor',1,req(3,...args[2]),0,'unknown_field','host-to-daemon',true);
emit('local_write_without_actor',1,req(3,...args[2].slice(0,3)),0,'ok','host-to-daemon',true);
raw('bad_truncated_header',Buffer.from([0,0]),'truncated');
raw('bad_truncated_payload',cat(num(4,4),[1],num(0,4),[1]),'truncated');
raw('bad_oversized_control',cat(num(1114113,4),[1],num(0,4)),'frame_too_large');
raw('bad_unknown_kind',cat(num(0,4),[99],num(0,4)),'unknown_kind');
raw('bad_stream_on_control',cat(num(0,4),[1],num(1,4)),'bad_stream');
// One extra byte inside the payload: len 6 = Welcome (5 bytes) + 00.
raw('bad_trailing_bytes',cat(header(6,0),un(4),[0]),'trailing_bytes');
// Refusals 5 and 6 (ADR ProtocolError table). 254 is no method in any protocol.
for(const [kind,name] of [[0,'hello'],[2,'events'],[3,'presence']])emit('bad_unknown_message_'+name,kind,un(9),0,'unknown_message');
emit('bad_unknown_method',1,req(254),0,'unknown_method');
// Kinds 4-6 require stream != 0; checked before len.
for(const [kind,name,p] of [[4,'documents',[1]],[5,'sessions',[7]],[6,'objects',[7]]])raw('bad_stream_zero_'+name,cat(header(p.length,kind),p),'bad_stream');
// Per-kind maximum + 1, header only: refused before any payload is read.
for(const [kind,name,max,stream] of [[0,'hello',8192,0],[2,'events',4194304,0],[3,'presence',65536,0],[4,'documents',4194304,1],[5,'sessions',65552,1],[6,'objects',65552,1]])raw('bad_oversized_'+name,header(max+1,kind,stream),'frame_too_large');
// Bounds the ADR states; each above-bound value is bad_value (error 12).
emit('bad_value_str_over_4096',1,req(2,f(1,str('a'.repeat(4097)))),0,'bad_value');
emit('bad_value_principal_over_1024',1,req(3,...args[2].slice(0,3),f(4,un(1,f(1,bytes(Buffer.alloc(1025,0x70)))))),0,'bad_value');
emit('bad_value_credential_over_1024',0,un(3,f(1,bytes(Buffer.alloc(1025,0x63))),f(2,id),f(3,num(7,8)),f(4,list(num(1,4)))),0,'bad_value','daemon-to-host');
emit('bad_value_sessions_over_512',0,un(3,f(1,bytes(Buffer.from('boot-token'))),f(2,id),f(3,num(7,8)),f(4,list(...Array.from({length:513},(_,i)=>num(i+1,4))))),0,'bad_value','daemon-to-host');
emit('bad_value_goodbye_detail_over_1024',0,un(5,f(1,[13]),f(2,str('d'.repeat(1025)))),0,'bad_value');
emit('bad_value_sess_data_over_65536',5,cat([1,1],Buffer.alloc(65537,0x61)),1,'bad_value','daemon-to-host');
emit('bad_value_obj_resize',6,cat([3],num(80,2),num(24,2)),1,'bad_value','daemon-to-host');
emit('bad_value_obj_data_fd',6,cat([1,1],Buffer.from('x')),1,'bad_value','daemon-to-host');
emit('bad_value_sess_exit_form',5,Buffer.from([5,2]),1,'bad_value','daemon-to-host');
emit('bad_value_ack_outcome',2,un(3,f(1,num(7,8)),f(2,[6])),0,'bad_value');
// ADR 0004 ruling 5: named stream bounds.
emit('bad_value_obj_signal',6,Buffer.from([4,1]),1,'bad_value','daemon-to-host');
emit('bad_value_obj_exit',6,cat([5,0],num(0,4)),1,'bad_value','daemon-to-host');
for(const [kind,name] of [[5,'sessions'],[6,'objects']])emit('bad_unknown_message_'+name,kind,Buffer.from([8]),1,'unknown_message','daemon-to-host');
emit('bad_value_sess_window_zero',5,cat([6],num(0,4)),1,'bad_value');
emit('bad_value_sess_window_over',5,cat([6],num(262145,4)),1,'bad_value');
for(const [n,name,expected] of [[1048576,'content_at_limit','ok'],[1048577,'content_over_limit','bad_value']])emit(name,1,req(3,f(1,str('a')),f(2,un(2)),f(3,bytes(Buffer.alloc(n,97))),f(4,actor)),0,expected);
// S3 document fixtures are literal tables, independent of either codec.
const docs=JSON.parse(readFileSync(dir+'doc-daemon.json','utf8'));
for(const d of docs.frames){const b=Buffer.from(d.hex,'hex');raw('doc-'+d.name,b,'ok',{kind:4,stream:9,payload:b.subarray(9).toString('hex'),local:false},d.msg===1||d.msg===2?'host-to-daemon':'daemon-to-host')}
emit('req_open_doc_s3',1,req(13,f(1,str('retry.ts')),f(2,un(1,f(1,bytes(Buffer.from('Be')))))));
emit('req_close_doc_s3',1,un(1,f(1,num(43,4)),f(2,un(14,f(1,num(9,4))))));
// Working-together I1: protocol 2 document bodies; all old tables stay byte-identical.
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
emit('ev_moved_off',2,durable(11,un(4,f(1,un(2,f(1,num(7,4)))),f(2,num(2,8)),f(3,Buffer.from('1234567890abcdef1234567890abcdef12345678','hex'))),eid(0xea)),0,'ok','daemon-to-host');
// Protocol 6: compare the whole text batch before mutation. Literal tables
// remain independent of both production encoders.
const batchActor=un(1,f(1,bytes(Buffer.from(Array.from({length:16},(_,i)=>i+1)))));
const sha=b=>createHash('sha256').update(b).digest();
const batchChanges=list(st(f(1,str('a')),f(2,un(2)),f(3,bytes(Buffer.from('x')))),st(f(1,str('b')),f(2,un(1,f(1,sha('before')))),f(3,bytes(Buffer.from('y')))));
const batchReq=(...fs)=>un(1,f(1,num(9,4)),f(2,un(17,...fs)));
const batchRes=(...fs)=>un(2,f(1,num(9,4)),f(2,un(17,...fs)));
const batchReceipt=st(f(1,un(1,f(1,sha('x')))));
const batchFailure=(index,preflight,code,...error)=>st(f(1,num(index,2)),f(2,[preflight]),f(3,st(f(1,[code]),...error)));
emit('req_write_files',1,batchReq(f(1,batchChanges),f(2,batchActor)));
emit('local_write_files',1,batchReq(f(1,batchChanges)),0,'ok','host-to-daemon',true);
emit('local_write_files_actor',1,batchReq(f(1,batchChanges),f(2,batchActor)),0,'unknown_field','host-to-daemon',true);
emit('res_write_files',1,batchRes(f(1,list(batchReceipt,st(f(1,un(1,f(1,sha('y')))))))),0,'ok','daemon-to-host');
emit('res_write_files_stale',1,batchRes(f(1,list()),f(2,batchFailure(1,1,4,f(3,sha('current'))))),0,'ok','daemon-to-host');
emit('res_write_files_partial',1,batchRes(f(1,list(batchReceipt)),f(2,batchFailure(1,0,12))),0,'ok','daemon-to-host');
const deletion=list(st(f(1,str('a')),f(2,un(1,f(1,sha('before'))))));
emit('req_delete_files',1,batchReq(f(1,deletion),f(2,batchActor)));
emit('local_delete_files',1,batchReq(f(1,deletion)),0,'ok','host-to-daemon',true);
emit('res_delete_files',1,batchRes(f(1,list(st(f(1,un(2)))))),0,'ok','daemon-to-host');
emit('req_move_files',1,batchReq(f(1,list(st(f(1,str('a')),f(2,un(1,f(1,sha('before'))))),st(f(1,str('b')),f(2,un(2)),f(3,bytes(Buffer.from('before')))))),f(2,batchActor)));
// #3562 committed these bytes by hand (moved_off tag 4 `returned`, and
// ev_transcript's event_id); generated here so --check covers them.
emit('ev_moved_off_returned',2,durable(11,un(4,f(1,un(2,f(1,num(7,4)))),f(2,num(2,8)),f(3,Buffer.from('1234567890abcdef1234567890abcdef12345678','hex')),f(4,[1])),id),0,'ok','daemon-to-host');
// A move's receipts: absent for the source deletion, the written digest for
// the destination (ADR:549-554).
emit('res_move_files',1,batchRes(f(1,list(st(f(1,un(2))),st(f(1,un(1,f(1,sha('before')))))))),0,'ok','daemon-to-host');
// Traversal is the engine's refusal, not the decoder's (ADR:204, :495, :505):
// these decode, and the answer is a preflight invalid_path with no receipts.
const deleteAt=path=>batchReq(f(1,list(st(f(1,str(path)),f(2,un(1,f(1,sha('before'))))))),f(2,batchActor));
emit('req_delete_files_dotdot',1,deleteAt('../a'));
emit('req_delete_files_absolute',1,deleteAt('/etc/passwd'));
emit('res_write_files_invalid_path',1,batchRes(f(1,list()),f(2,batchFailure(0,1,6))),0,'ok','daemon-to-host');
// A method-17 path is a str (ADR:68): NUL is bad_utf8, 4,097 bytes bad_value.
emit('bad_utf8_write_files_path_nul',1,batchReq(f(1,list(st(f(1,cat(num(3,2),Buffer.from('a\0b'))),f(2,un(1,f(1,sha('before'))))))),f(2,batchActor)),0,'bad_utf8');
emit('bad_value_write_files_path_over_4096',1,deleteAt('a'.repeat(4097)),0,'bad_value');
// Busy during deletion is an application failure, never a stale no-op (ADR:560).
emit('res_write_files_busy',1,batchRes(f(1,list()),f(2,batchFailure(0,0,9,f(4,num(1,4))))),0,'ok','daemon-to-host');
const previous=JSON.parse(readFileSync(dir+'MANIFEST.json','utf8'));
// Sequence steps name their connection (ADR 0004 ruling 4); `a` unless given.
const steps=(...names)=>names.map(n=>typeof n==='string'?{conn:'a',frame:n}:n);
const on=(conn,...names)=>names.map(frame=>({conn,frame}));
const handshake=['hello_challenge','hello_host_proof','hello_machine','hello_welcome'];
const sequences={
  seq_working_together:steps('req_set_roster','res_set_roster','req_open_doc_s3','doc-epoch','doc-input-v2','doc-saved-v2','req_write_file','res_write_file_raced','req_set_roster_empty','res_set_roster'),
  seq_handshake:steps(...handshake),
  seq_write_stale:steps('req_write_file','err_stale'),
  seq_capture:steps('obj_data','obj_eof','ev_captured','ack_captured'),
  // The resent bundle goes on a fresh daemon stream (ADR:54, :252).
  seq_missing_objects:steps('ack_missing_objects','obj_resend_data','obj_resend_eof','ev_burst','ack_applied'),
  seq_duplicate_receipt:steps('ev_burst','ack_duplicate'),
  // After Welcome the batch is preceded by its objects (ADR:247, :252).
  seq_reconnect_replay:steps(...handshake,'obj_replay_data','obj_replay_eof','ev_burst','ev_captured'),
  seq_reserved_doc_s2:steps('doc_reserved_sync','doc_refused_unsupported'),
  // a live; b (newer boot) accepted; a superseded; c answers its own
  // challenge on b's boot (fresh nonce, valid proof), presents a's older
  // credential and is refused.
  seq_newer_boot:[...on('a',...handshake),...on('b','hello_challenge_b','hello_host_proof_b','hello_machine_b','hello_welcome'),...on('a','goodbye_superseded'),...on('c','hello_challenge_c','hello_host_proof_c','hello_machine','goodbye_auth_failed')],
  seq_move_files:steps('req_move_files','res_move_files'),
  seq_delete_dotdot:steps('req_delete_files_dotdot','res_write_files_invalid_path'),
  seq_delete_absolute:steps('req_delete_files_absolute','res_write_files_invalid_path'),
  seq_delete_busy:steps('req_delete_files','res_write_files_busy'),
  seq_wake_objects:steps('obj_host_data','obj_host_eof','obj_host_close','req_wake_reconcile'),
};
// Handshake refusals only a handshake state machine detects. `by` names the
// side whose production handshake must return `expected` after the last step
// and then send `goodbye_<expected>`: the Rust daemon (link::authenticate) or
// the Go host (Registry.Connect).
const refusals={
  seq_order_daemon:{by:'daemon',expected:'handshake_order',steps:steps('hello_challenge','req_status')},
  seq_order_host:{by:'host',expected:'handshake_order',steps:steps('hello_challenge','hello_host_proof','res_status')},
  seq_version_older_daemon:{by:'daemon',expected:'version_mismatch',steps:steps('hello_challenge','hello_host_proof_older')},
  seq_version_newer_daemon:{by:'daemon',expected:'version_mismatch',steps:steps('hello_challenge','hello_host_proof_newer')},
  seq_version_older_host:{by:'host',expected:'version_mismatch',steps:steps('hello_challenge_older')},
  seq_version_newer_host:{by:'host',expected:'version_mismatch',steps:steps('hello_challenge_newer')},
  seq_bad_mac_daemon:{by:'daemon',expected:'auth_failed',steps:steps('hello_challenge','hello_host_proof_bad_mac')},
};
const hex=b=>Buffer.from(b).toString('hex');
const handshake_vectors=Object.fromEntries(Object.entries(vectors).map(([k,v])=>[k,{secret:hex(v.secret),boot_id:hex(v.boot_id),nonce:hex(v.nonce),protocol,mac_input:hex(macInput(v)),mac:v.mac}]));
// Document bodies belong to the one connection protocol (ADR 0004 §handshake).
const {document_protocol,legacy_protocols,...kept}=previous;
const manifest={...kept,scope:"ADR 0004 daemon contract and T-COL-08b browser fixtures",protocol,
  mac:{definition:'HMAC-SHA256(relay secret, "'+MAC_LABEL+'" || u16 big-endian protocol || boot_id || nonce); the label is ASCII without a length or NUL, boot_id is the 16 raw bytes, nonce the 32 raw bytes, the key the 32 bytes the boot file writes as 64 hex',source:'Python hmac, cross-checked with openssl'},
  handshake_vectors,pins:{...previous.pins,yrs:'=0.27.4'},
  frames:entries.map(e=>({name:e.name,direction:e.direction,expected:e.expected,local:e.value?.local??false,...e.extra,sha256:createHash('sha256').update(e.b).digest('hex')})),
  sequences,refusal_sequences:refusals};
for(const list of [...Object.values(sequences),...Object.values(refusals).map(r=>r.steps)])for(const s of list)if(!entries.some(e=>e.name===s.frame))throw Error('sequence names unknown frame '+s.frame);
for(const r of Object.values(refusals))if(!entries.some(e=>e.name==='goodbye_'+r.expected))throw Error('no goodbye_'+r.expected);
function save(name,bytes){if(check){if(!readFileSync(dir+name).equals(Buffer.from(bytes)))throw Error('fixture drift: '+name)}else writeFileSync(dir+name,bytes)}
for(const e of entries){save(e.name+'.bin',e.b);save(e.name+'.json',JSON.stringify(e.value??{expected:e.expected},null,2)+'\n')}
save('MANIFEST.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`${entries.length} golden frames ${check?'verified':'written'}`);
