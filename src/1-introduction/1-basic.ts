/**
 * 1 - Basic LLM call: send messages, get text back.
 *
 * Run it with: npm run intro:basic
 *
 * HOW TO READ THE COMMENTS IN THIS PROJECT
 *   - Comments that start with "TS:" teach a TypeScript / JavaScript idea.
 *   - All other comments explain what the program does.
 *
 * New TypeScript ideas in this file:
 *   importing your own modules, `const`, `await`, options objects, the
 *   spread operator `...`, type inference, `?.`
 */

// TS: Imports that start with "./" or "../" are files in THIS project. Imports
// without a leading dot ("openai", "zod") are packages from node_modules. The
// names in braces must match what that file `export`s.
//
// Every script shares the client made in src/lib/llm.ts, because that file
// also decides where the model runs: OpenAI when you have an API key, Ollama
// on your own computer when you don't. Read it after this file.
import { client, modelOptions } from "../lib/llm";

// TS: `const` declares a variable that can never be reassigned. Its sibling
// `let` allows reassignment. Reach for `const` by default and only use `let`
// when you really do reassign.
//
// TS: In JavaScript, anything that touches the network is ASYNCHRONOUS:
// `create(...)` returns immediately with a `Promise`, an object that
// represents "a result that will exist later". `await` pauses here until the
// Promise is finished and hands you the real value.
//
// TS: We can use `await` outside of any function ("top-level await") because
// this project uses ES modules. That is the `"type": "module"` line in
// package.json.
//
// TS: JavaScript has no named arguments. The convention is to pass ONE object
// holding the options: `create({ model: ..., messages: ... })`.
const completion = await client.chat.completions.create({
  // TS: `...` in front of an object is the SPREAD operator: it copies that
  // object's properties into this one.
  //
  // With OpenAI, `modelOptions("gpt-4o")` is `{ model: "gpt-4o" }`, so this
  // line means the same as writing `model: "gpt-4o"`. With Ollama it holds
  // the name of your local model instead.
  ...modelOptions("gpt-4o"),
  messages: [
    { role: "system", content: "You're a helpful assistant." },
    {
      role: "user",
      content: "Write a limerick about the Python programming language.",
    },
  ],
});

// TS: We never wrote a type for `completion`, yet TypeScript knows it is a
// `ChatCompletion`. That is TYPE INFERENCE: the type comes from the function's
// declared return type. Hover over any variable in VS Code to see what was
// inferred. Try typing `completion.` and look at the autocomplete list.
//
// TS: `?.` is OPTIONAL CHAINING. `choices` is an array and arrays can be
// empty, so `choices[0]` might be `undefined`. With `?.`, if the left side is
// null or undefined the whole expression becomes `undefined` instead of
// crashing. TypeScript makes you deal with that possibility before the
// program ever runs.
//
// Hover over `response`: its type is `string | null | undefined`.
//   string    -> the model's text
//   null      -> the model answered without text (for example with a tool call)
//   undefined -> there was no first choice at all (that is the `?.` at work)
// JavaScript really does have two different "nothing" values.
const response = completion.choices[0]?.message.content;
console.log(response);
