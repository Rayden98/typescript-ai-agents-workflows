/**
 * 2 - Structured output: make the model answer with JSON in a fixed shape.
 *
 * Run it with: npm run intro:structured
 *
 * New TypeScript ideas in this file:
 *   Zod schemas, `z.infer`, type annotations, union types,
 *   narrowing with `if`
 */

// TS: A package can expose several entry points. "openai/helpers/zod" is a
// sub-path of the openai package.
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { client, modelOptions } from "../lib/llm";

// --------------------------------------------------------------
// Step 1: Define the response format in a Zod schema
// --------------------------------------------------------------

// TS: The most important thing to understand about TypeScript:
//
//     TYPES DO NOT EXIST AT RUNTIME.
//
// They are checked by the compiler and then erased, leaving plain JavaScript.
// So a plain TypeScript type cannot be sent to OpenAI, and it cannot check the
// JSON that comes back. We need a real runtime object for that.
//
// The Zod library provides one. `z.object({...})` builds a SCHEMA: a normal
// JavaScript value that can
//   1. be converted into the JSON Schema that OpenAI needs, and
//   2. validate the model's reply when it arrives.
const CalendarEvent = z.object({
  name: z.string(),
  date: z.string(),
  participants: z.array(z.string()),
});

// TS: Now we derive a static type FROM the schema, so the two can never drift
// apart. Read it inside-out:
//   `typeof CalendarEvent`  -> "the type of the constant above"
//   `z.infer<...>`          -> "the shape of the data that schema accepts"
//
// The result is exactly what you would get by writing it by hand:
//
//     type CalendarEvent = {
//       name: string;
//       date: string;
//       participants: string[];   // an array of strings
//     };
//
// TS: Yes, the const and the type have the same name. That is allowed because
// TypeScript keeps values and types in two separate namespaces, and it is a
// common Zod convention: one name, usable both ways.
type CalendarEvent = z.infer<typeof CalendarEvent>;

// --------------------------------------------------------------
// Step 2: Call the model
// --------------------------------------------------------------

// `.parse()` is `.create()` plus automatic validation of the reply.
const completion = await client.chat.completions.parse({
  ...modelOptions("gpt-4o"),
  messages: [
    { role: "system", content: "Extract the event information." },
    {
      role: "user",
      content: "Alice and Bob are going to a science fair on Friday.",
    },
  ],
  // The second argument is the schema's name, which the API requires.
  response_format: zodResponseFormat(CalendarEvent, "CalendarEvent"),
});

// --------------------------------------------------------------
// Step 3: Parse the response
// --------------------------------------------------------------

// TS: The part after the colon is a TYPE ANNOTATION.
// We don't have to write it, since TypeScript infers this exact type. Spelling
// it out once shows the three things `.parsed` can be:
//   CalendarEvent -> validated data
//   null          -> the model refused to answer
//   undefined     -> `choices[0]` did not exist (from the `?.`)
const event: CalendarEvent | null | undefined = completion.choices[0]?.message.parsed;

// TS: This is NARROWING. Outside the `if`, `event` might be null or undefined,
// so `event.name` would be a compile error. Inside the `if` TypeScript knows
// those cases are ruled out and treats `event` as a plain `CalendarEvent`.
// Try moving one of the `console.log` lines below the closing brace.
if (event) {
  console.log(event.name);
  console.log(event.date);
  console.log(event.participants);
}
