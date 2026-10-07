#ifndef SMITHERS_LIVE_DOCUMENT_H
#define SMITHERS_LIVE_DOCUMENT_H
#include <stdint.h>
#include <stddef.h>
/* I5, Yjs v1, UTF-16. Every input is borrowed for the call. Every result must
 * be freed exactly once with ld_free. Status 0=ok, 1=refused, 2=invalid, 3=panic.
 * Handles are process-local, never reused, thread-safe; close excludes new calls.
 * In-flight calls may finish during close. Never persist handles.
 * Open and set_author are trusted-host operations. Apply requires a registered
 * authenticated client id. Missing causal updates refuse without mutation: sync
 * and retry. Awareness must already be identity-stamped by the host.
 * No function acknowledges persistence. Limits: text 1 MiB, input 16 MiB.
 */
typedef struct { uint8_t *data; size_t len; uint32_t status; } LdResult;
uint64_t ld_open(uint32_t kind, const uint8_t *state, size_t len);
LdResult ld_apply(uint64_t h, uint64_t client, const uint8_t *update, size_t len);
/* Authenticated daemon only; never browser-controlled admission. */
LdResult ld_peer(uint64_t h, const uint8_t *update, size_t len);
LdResult ld_sync1(uint64_t h);
LdResult ld_sync2(uint64_t h, const uint8_t *sv, size_t len);
LdResult ld_awareness(uint64_t h, const uint8_t *bytes, size_t len);
LdResult ld_set_author(uint64_t h, uint64_t client, const uint8_t *actor, size_t len);
LdResult ld_state(uint64_t h);
LdResult ld_text(uint64_t h, const uint8_t *root, size_t len);
LdResult ld_close(uint64_t h);
void ld_free(LdResult result);
#endif
