/**
 * Maps signal names onto Linux signal numbers.
 *
 * @since 0.1.0
 */

import type { Signal } from "effect/unstable/process/ChildProcess"

/**
 * The Linux numbering. Guests are Linux, so a name's number is the guest's
 * whatever platform the host runs on. Names Linux has no signal for are
 * absent.
 */
const numbers: Partial<Record<Signal, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSTKFLT: 16,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPOLL: 29,
  SIGPWR: 30,
  SIGSYS: 31,
  SIGUNUSED: 31
}

/**
 * The Linux number of a signal name, or `undefined` for a name Linux does not
 * define (`SIGBREAK`, `SIGLOST`, `SIGINFO`).
 *
 * @category constructors
 * @since 0.1.0
 */
export const linuxSignalNumber = (signal: Signal): number | undefined => numbers[signal]
