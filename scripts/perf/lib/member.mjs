/** Verify the session represented by a browser fixture through public reads.
 * Never accept seeded UI, a filename, or a caller-supplied member id as identity.
 */
export async function authenticatedMember(context, origin) {
  const options = { maxRedirects: 0, timeout: 10000 }
  const response = await context.request.get(`${origin}/api/user`, options)
  if (response.status() !== 200) throw new Error(`member fixture: GET /api/user returned ${response.status()}`)
  const member = await response.json()
  if (!Number.isSafeInteger(member.id) || member.id < 1 || typeof member.username !== 'string' || !member.username) throw new Error('member fixture has no authenticated identity')
  const conversation = await context.request.get(`${origin}/api/conversations/main`, options)
  if (conversation.status() !== 200) throw new Error(`member fixture: conversation returned ${conversation.status()}`)
  const value = await conversation.json()
  if (typeof value.id !== 'string' || !value.id || !Array.isArray(value.entries)) throw new Error('member fixture: invalid conversation')
  return { id: member.id, username: member.username, conversation: value.id }
}

export function distinctMembers(members) {
  if (new Set(members.map(member => member.id)).size !== members.length) throw new Error('distinct authenticated members required')
}
