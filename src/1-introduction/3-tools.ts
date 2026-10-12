/**
 * 3 - Tool use: let the model ask us to run a function, then give it the result.
 *
 * Run it with: npm run intro:tools
 * Docs:        https://platform.openai.com/docs/guides/function-calling
 *
 * New TypeScript ideas in this file:
 *   typed functions, `async` / `Promise<T>`, `unknown`, `import type`,
 *   annotating arrays, destructuring, `for...of`, discriminated unions, `??`
 */

import { zodResponseFormat } from "openai/helpers/zod";
// TS: `import type` brings in names that are ONLY types. They vanish when the
// code runs. Here they are the SDK's descriptions of what a message and a tool
// definition look like.
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { z } from "zod";

import { client, modelOptions } from "../lib/llm";
import { getParsedOrThrow } from "../lib/structured-output";

// --------------------------------------------------------------
// Define the tool (function) that we want to call
// --------------------------------------------------------------

// The part of the weather API's reply that we use. The keys are snake_case
// because they are the API's field names, not ours to rename.
const CurrentWeather = z.object({
  time: z.string(),
  interval: z.number(),
  temperature_2m: z.number(),
  wind_speed_10m: z.number(),
});
type CurrentWeather = z.infer<typeof CurrentWeather>;

const ForecastResponse = z.object({ current: CurrentWeather });

/**
 * This is a publicly available API that returns the weather for a given location.
 */
// TS: A `/** ... */` comment directly above a function is a JSDoc comment:
// the function's documentation. Editors show it when you hover over the
// function.
//
// TS: Parameter types go after the name (`latitude: number`), the return type
// goes after the parentheses. There is no separate type for whole numbers and
// decimals: every number is a `number`.
//
// TS: `async` lets the function use `await`, and it changes the return type:
// an async function ALWAYS returns a Promise. So the annotation is
// `Promise<CurrentWeather>`, read as "a CurrentWeather, later".
async function getWeather(latitude: number, longitude: number): Promise<CurrentWeather> {
  // `fetch` is built into Node, so HTTP requests need no extra package. The
  // backtick string is a TEMPLATE LITERAL: each `${...}` is replaced by the
  // value of the expression inside it.
  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`,
  );
  if (!response.ok) {
    throw new Error(`Weather API request failed: ${response.status} ${response.statusText}`);
  }

  // TS: `response.json()` gives back `unknown`: "there is a value here, but
  // nobody has checked what it is". TypeScript will not let you touch an
  // `unknown` (no `data.current`) until you prove its shape. Its careless
  // cousin is `any`, which switches type checking OFF for that value. Prefer
  // `unknown`.
  const data: unknown = await response.json();

  // Zod does the proving: `.parse()` throws if the data has the wrong shape and
  // otherwise returns it with a real type.
  return ForecastResponse.parse(data).current;
}

// --------------------------------------------------------------
// Step 1: Call model with get_weather tool defined
// --------------------------------------------------------------

// TS: `ChatCompletionTool[]` means "an array of ChatCompletionTool".
// With this annotation TypeScript checks every key of the object below as you
// type. Misspell `parameters` or write `type: "funtion"` and you get a red
// squiggle immediately, instead of an error once the request reaches the API.
//
// The tool's NAME stays "get_weather": that string is what the model sees and
// sends back. It does not have to match our function's name (`getWeather`).
// `callFunction` below is what connects the two.
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current temperature for provided coordinates in celsius.",
      parameters: {
        type: "object",
        properties: {
          latitude: { type: "number" },
          longitude: { type: "number" },
        },
        required: ["latitude", "longitude"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

// The arguments the model sends for `get_weather`, as a Zod schema so we can
// validate them before calling our function. (The SDK also has a `zodFunction`
// helper that generates the JSON above from a schema like this one. The JSON
// is written by hand here so you can see exactly what the model receives.)
const GetWeatherArgs = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

const systemPrompt = "You are a helpful weather assistant.";

// TS: This annotation is required, not decoration. Without it TypeScript
// infers the array's type from its first two items:
//     { role: string; content: string }[]
// and that breaks twice. `role` is now "any string" instead of one of the
// allowed roles, so `create()` refuses the array. And the tool-result message
// we push later has an extra `tool_call_id` key, which does not fit that
// inferred shape. `ChatCompletionMessageParam` is a union of every kind of
// message the API accepts, so all of them fit. (Delete the annotation and read
// the two errors.)
const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: "What's the weather like in Paris today?" },
];

const completion = await client.chat.completions.create({
  ...modelOptions("gpt-4o"),
  // TS: SHORTHAND PROPERTIES. When the key and the variable have the same
  // name, `messages` is short for `messages: messages`.
  messages,
  tools,
});

// --------------------------------------------------------------
// Step 2: Model decides to call function(s)
// --------------------------------------------------------------

// `console.dir` with `depth: null` prints the whole nested object instead of
// collapsing the inner levels.
console.dir(completion, { depth: null });

// --------------------------------------------------------------
// Step 3: Execute get_weather function
// --------------------------------------------------------------

// TS: `args` is `unknown` because it comes from the model, so nothing
// guarantees its shape yet. The return type is `Promise<unknown>` because
// each tool may return something different.
async function callFunction(name: string, args: unknown): Promise<unknown> {
  // TS: `===` is strict equality and is the one to use. The older `==`
  // converts types before comparing (`"1" == 1` is true), which causes bugs.
  if (name === "get_weather") {
    // TS: DESTRUCTURING pulls properties out of an object into variables.
    // After `.parse()`, TypeScript knows both values are numbers.
    const { latitude, longitude } = GetWeatherArgs.parse(args);
    return getWeather(latitude, longitude);
  }
  throw new Error(`Unknown tool: ${name}`);
}

const assistantMessage = completion.choices[0]?.message;
if (!assistantMessage) {
  throw new Error("The model returned no choices.");
}

// The assistant's turn (the one holding the tool calls) goes into the
// conversation first, followed by one "tool" message per call.
//
// TS: `messages` is a `const`, yet we can `.push()` to it. `const` only stops
// you from REASSIGNING the variable (`messages = [...]`). The array it points
// to can still change.
messages.push(assistantMessage);

// TS: `for...of` loops over the VALUES of an array. (Careful: `for...in` also
// exists and loops over keys/indexes. You rarely want that one.)
//
// TS: `??` is NULLISH COALESCING: "use the left side unless it is null or
// undefined". `tool_calls` is missing when the model answers with plain text,
// so we fall back to an empty array and the loop simply does nothing.
for (const toolCall of assistantMessage.tool_calls ?? []) {
  // TS: `toolCall` is a DISCRIMINATED UNION: either a "function" call or a
  // "custom" call, and only the function kind has a `.function` property.
  // Checking the shared `type` field tells TypeScript which one we have. After
  // this line it knows `toolCall.function` exists. We only defined function
  // tools, so this never actually skips anything.
  if (toolCall.type !== "function") {
    continue;
  }

  const name = toolCall.function.name;
  // `JSON.parse` returns `any`. Annotating the variable as `unknown` puts the
  // safety back on.
  const args: unknown = JSON.parse(toolCall.function.arguments);

  const result = await callFunction(name, args);
  messages.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify(result), // the result as JSON text
  });
}

// --------------------------------------------------------------
// Step 4: Supply result and call model again
// --------------------------------------------------------------

// `.describe()` adds a description to a field: a hint that is sent to the
// model along with the schema.
const WeatherResponse = z.object({
  temperature: z
    .number()
    .describe("The current temperature in celsius for the given location."),
  response: z.string().describe("A natural language response to the user's question."),
});

const completion2 = await client.chat.completions.parse({
  ...modelOptions("gpt-4o"),
  messages,
  tools,
  response_format: zodResponseFormat(WeatherResponse, "WeatherResponse"),
});

// --------------------------------------------------------------
// Step 5: Check model response
// --------------------------------------------------------------

// `getParsedOrThrow` is our small helper from src/lib/structured-output.ts.
// Hover over `finalResponse`: TypeScript already knows it is
// `{ temperature: number; response: string }`, with no annotation from us.
const finalResponse = getParsedOrThrow(completion2);
console.log(finalResponse.temperature);
console.log(finalResponse.response);
