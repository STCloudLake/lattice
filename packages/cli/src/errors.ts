/**
 * Exit codes for the M0 CLI surface (agreed in the delivery spec):
 *   0 = ok · 1 = usage error · 2 = data error.
 *
 * Data errors are "the input is not usable": doctor found problems or eval has
 * zero scoreable samples. Usage errors are "the invocation is wrong": unknown
 * flag, missing required flag, refusing to overwrite.
 */
export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_DATA = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_USAGE | typeof EXIT_DATA;

/** A failure the user can act on (never a stack trace in normal operation). */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(code: ExitCode, message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
  }
}
