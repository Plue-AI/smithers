/** Committed v1 records: retain these bytes when extending the protocol. */
export const fixtures = [
  "{\"t\":\"sub\",\"id\":7,\"topic\":\"todo:12\",\"cursor\":1043}",
  "{\"t\":\"unsub\",\"id\":7}",
  "{\"t\":\"snap\",\"id\":7,\"cursor\":1050,\"data\":{\"state\":\"queued\"}}",
  "{\"t\":\"delta\",\"id\":7,\"cursor\":1051,\"data\":{\"state\":\"starting\"}}",
  "{\"t\":\"gap\",\"id\":7}",
  "{\"t\":\"err\",\"id\":7,\"code\":\"unknown_topic\"}",
  "{\"t\":\"err\",\"id\":7,\"code\":\"forbidden\"}",
  "{\"t\":\"err\",\"id\":7,\"code\":\"unsupported\"}"
] as const
