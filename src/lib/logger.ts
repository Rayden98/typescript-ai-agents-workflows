/**
 * A tiny logger that prints lines in this format:
 *
 *     2026-10-10 14:03:22 - INFO - Processing calendar request
 *
 * JavaScript's only built-in is `console`, so we write the few lines ourselves.
 */

// TS: `type` gives a name to a type. This one is a UNION (`|` reads as "or")
// of STRING LITERAL types: a LogLevel is not "any string", it is exactly one
// of these three strings. `log("INFOO", ...)` would be a compile error.
type LogLevel = "DEBUG" | "INFO" | "WARNING";

// TS: `Record<K, V>` means "an object whose keys are K and whose values are V".
// Because the key type is LogLevel, TypeScript insists that every level
// appears here. Delete one line and see the error.
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
};

// Messages below this level are hidden. Change it to "DEBUG" to also see the
// `logger.debug(...)` lines.
const MINIMUM_LEVEL: LogLevel = "INFO";

// TS: The `: string` after the parentheses is the RETURN TYPE.
function timestamp(): string {
  const now = new Date();

  // TS: An ARROW FUNCTION stored in a variable: a short way to write a
  // function. `(value: number): string => ...` reads as "takes a number,
  // returns a string".
  const pad = (value: number): string => String(value).padStart(2, "0");

  // Careful: JavaScript months are 0-based (January is 0), hence the `+ 1`.
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date} ${time}`;
}

// TS: `void` is the return type of a function that returns nothing useful.
function log(level: LogLevel, message: string): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MINIMUM_LEVEL]) {
    return;
  }

  // `console.error` writes to stderr. That keeps log lines separate from the
  // program's real output (`console.log`, which goes to stdout).
  console.error(`${timestamp()} - ${level} - ${message}`);
}

// TS: `export` makes this visible to other files. Without it, everything in a
// file is private to that file.
//
// We export one object with three methods, so call sites read
// `logger.info("...")`, `logger.warning("...")`.
export const logger = {
  debug: (message: string): void => log("DEBUG", message),
  info: (message: string): void => log("INFO", message),
  warning: (message: string): void => log("WARNING", message),
};
