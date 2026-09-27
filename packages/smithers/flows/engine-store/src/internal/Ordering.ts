/**
 * Host-locale-independent UTF-16 code-unit ordering for durable material.
 *
 * @since 1.0.0
 */

/**
 * Compares two strings by JavaScript's locale-independent UTF-16 relational
 * order.
 *
 * @category ordering
 * @since 1.0.0
 */
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
