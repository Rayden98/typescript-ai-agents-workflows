/**
 * One small helper shared by the scripts that ask the model for structured
 * output (JSON that matches a schema).
 *
 * Reading the parsed result out of a completion can go wrong in two ways:
 * `choices` could be empty, and `parsed` is `null` when the model refuses to
 * answer. TypeScript's strict mode will not let us ignore those cases, so we
 * handle them once, here, and every script gets a clean value back.
 */

// TS: `import type` imports something that exists ONLY at compile time. It is
// erased completely when the code runs, so it costs nothing at runtime.
import type { ParsedChatCompletion } from "openai/resources/chat/completions";

// TS: `<T>` makes this a GENERIC function. `T` is a placeholder for "whatever
// type the caller's schema describes". The signature reads:
//
//     give me a completion whose parsed content is a T, and I return a T
//
// So passing a completion for an `EventDetails` schema returns `EventDetails`,
// and TypeScript works that out by itself at each call site.
export function getParsedOrThrow<T>(completion: ParsedChatCompletion<T>): T {
  // TS: `?.` is OPTIONAL CHAINING. If `choices[0]` is undefined (empty array),
  // the whole expression becomes `undefined` instead of throwing an error.
  const message = completion.choices[0]?.message;
  const parsed = message?.parsed;

  // At this point TypeScript knows `parsed` is `T | null | undefined`.
  if (parsed === null || parsed === undefined) {
    // TS: `??` is NULLISH COALESCING: use the left side unless it is null or
    // undefined, otherwise use the right side. Unlike `||`, it does NOT treat
    // "" or 0 as missing.
    // `refusal` holds the model's explanation when it declines to answer.
    throw new Error(message?.refusal ?? "The model did not return any structured output.");
  }

  // TS: This is NARROWING. Because the `if` above threw for null/undefined,
  // TypeScript now knows `parsed` can only be a `T`, so returning it is allowed.
  return parsed;
}
