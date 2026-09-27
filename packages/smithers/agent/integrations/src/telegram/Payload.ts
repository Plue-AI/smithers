/**
 * Schemas for the Bot API objects this package delivers as payloads.
 *
 * Core fields are typed and everything else passes through, so a workflow can
 * read a Bot API field this package does not model.
 *
 * @since 1.0.0
 */

import { Schema } from "effect"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

const open = <Fields extends Schema.Struct.Fields>(fields: Fields) => Schema.StructWithRest(Schema.Struct(fields), rest)

/**
 * A chat.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Chat = open({
  id: Schema.Number,
  type: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String)
})

/**
 * A user.
 *
 * @category schemas
 * @since 1.0.0
 */
export const User = open({
  id: Schema.Number,
  is_bot: Schema.optional(Schema.Boolean),
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String)
})

/**
 * A message, delivered for `integration:telegram:message` and
 * `integration:telegram:edited_message`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Message = open({
  message_id: Schema.Number,
  date: Schema.Number,
  chat: Chat,
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  message_thread_id: Schema.optional(Schema.Number),
  is_topic_message: Schema.optional(Schema.Boolean),
  reply_to_message: Schema.optional(open({ message_id: Schema.Number })),
  photo: Schema.optional(Schema.Array(open({ file_id: Schema.String }))),
  document: Schema.optional(open({ file_id: Schema.String, file_name: Schema.optional(Schema.String) }))
})

/**
 * An inline-keyboard press, delivered for `integration:telegram:callback_query`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CallbackQuery = open({
  id: Schema.String,
  from: User,
  data: Schema.optional(Schema.String),
  message: Schema.optional(Message)
})

/**
 * The `web_app_data` a reply-keyboard Mini App's `sendData` attaches.
 *
 * The `data` string is untrusted, though the sender is Telegram-guaranteed.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WebAppData = open({ data: Schema.String, button_text: Schema.optional(Schema.String) })

/**
 * The message carrying `web_app_data`, delivered for
 * `integration:telegram:web_app_data`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WebAppDataMessage = open({
  message_id: Schema.Number,
  date: Schema.Number,
  chat: Chat,
  from: Schema.optional(User),
  text: Schema.optional(Schema.String),
  message_thread_id: Schema.optional(Schema.Number),
  web_app_data: Schema.optional(WebAppData)
})
