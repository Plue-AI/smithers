// Run in the installed guest against Claude's actual stream-json output.
// A CLI confirmation is deliberately exit 3, which Bash may mark is_error.
// Accept it only for the requested command and a literal pending receipt.
export const terminalSkillProof = (
  expected: readonly string[],
  confirmationCommand?: string,
  refusal?: { code: string; message: string }
) => `import json,sys
messages=[json.loads(line) for line in sys.stdin]
results=[m for m in messages if m.get('type')=='result']
assert len(results)==1 and results[0].get('subtype')=='success' and not results[0].get('is_error'), 'Claude did not finish successfully'
blocks=[block for message in messages for block in message.get('message',{}).get('content',[]) if isinstance(block,dict)]
commands={block['id']:block.get('input',{}).get('command','') for block in blocks if block.get('type')=='tool_use' and block.get('name')=='Bash'}
tool_results=[block for block in blocks if block.get('type')=='tool_result']
assert tool_results, 'Claude produced no tool results'
expected=${JSON.stringify(expected)}
confirmation_command=${confirmationCommand ? JSON.stringify(confirmationCommand) : "None"}
refusal=${refusal ? JSON.stringify(refusal) : "None"}
completed=set()
confirmations=[]
refused=False
def objects(content):
 text=content if isinstance(content,str) else '\\n'.join(block.get('text','') for block in content if isinstance(block,dict))
 decoder=json.JSONDecoder()
 values=[]
 offset=0
 while offset<len(text):
  if text[offset] not in '{[':
   offset+=1
   continue
  try: value,length=decoder.raw_decode(text[offset:])
  except ValueError:
   offset+=1
   continue
  if isinstance(value,(dict,list)): values.append(value)
  offset+=length
 return values
for block in tool_results:
 command=commands.get(block.get('tool_use_id'),'')
 receipts=objects(block.get('content',''))
 pending=[value for value in receipts if isinstance(value,dict) and value.get('state')=='pending' and isinstance(value.get('confirmation'),str) and value['confirmation'].strip()]
 is_confirmation=confirmation_command is not None and 'smthrs '+confirmation_command in command and bool(pending)
 is_refusal=refusal is not None and 'smthrs todo new' in command and any(isinstance(value,dict) and value.get('class')=='permission' and value.get('code')==refusal['code'] and value.get('message')==refusal['message'] for value in receipts)
 assert not block.get('is_error') or is_confirmation or is_refusal, 'Claude skill tool failed'
 for name in expected:
  if 'smthrs '+name in command:
   assert receipts, 'Smithers command produced no JSON receipt'
   assert is_refusal or not any(isinstance(value,dict) and value.get('class') in ('permission','user','infra','conflict') for value in receipts), 'Smithers command returned a typed failure'
   completed.add(name)
 if is_confirmation: confirmations.extend(value['confirmation'] for value in pending)
 refused=refused or is_refusal
assert all(name in completed for name in expected), 'Missing completed Smithers skill command'
assert refusal is None or refused, 'Claude skill did not receive the literal refusal'
if confirmation_command is not None:
 assert len(confirmations)==1, 'Expected exactly one pending CLI confirmation'
 print('J6'+'CONFIRMATION='+confirmations[0])
print('J6'+'SKILL=executed')`
