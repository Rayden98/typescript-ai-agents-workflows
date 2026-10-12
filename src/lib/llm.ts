/**
 * Creates the one LLM client that every script shares, and decides where the
 * model runs:
 *
 *     OPENAI_API_KEY is set   ->  OpenAI, with the model each script asks for
 *     no key                  ->  Ollama, a model running on your own computer
 *
 * One client class covers both, because Ollama serves the same HTTP API as
 * OpenAI (it is "OpenAI-compatible"). We only point the client at a different
 * address.
 *
 * New TypeScript ideas in this file:
 *   `new`, `process.env`, the `? :` operator, `||` for default values,
 *   `interface` with an optional property, `let`, `try` / `catch`
 */

// Runs src/lib/env.ts, which loads your `.env` file. It is the first import so
// that the settings are in place before the code below reads them.
import "./env";

import OpenAI from "openai";

import { logger } from "./logger";

// --------------------------------------------------------------
// Step 1: Decide which provider to use
// --------------------------------------------------------------

// `process.env` holds the environment variables of the running program.
//
// TS: Hover over `openaiApiKey`: its type is `string | undefined`. An
// environment variable may simply not exist, and TypeScript makes that
// possibility part of the type.
const openaiApiKey = process.env.OPENAI_API_KEY;

type Provider = "openai" | "ollama";

// TS: `condition ? a : b` is the CONDITIONAL (or "ternary") operator: it
// gives `a` when the condition is true and `b` when it is not.
//
// An empty string counts as false. So a `.env` with a blank `OPENAI_API_KEY=`
// line means "no key", the same as no line at all.
const provider: Provider = openaiApiKey ? "openai" : "ollama";

/** True when the scripts run on a local Ollama model instead of OpenAI. */
// A script can import this to adjust what it asks for: a small model on your
// own computer is slower and can read and write far less text per request.
export const usingLocalModel = provider === "ollama";

// Settings for Ollama. Each has a default that you can override in `.env`.
//
// TS: `a || b` gives `a`, unless `a` is falsy (here: undefined or an empty
// string), in which case it gives `b`.
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const ollamaModel = process.env.OLLAMA_MODEL || "qwen3.5:2b";

// --------------------------------------------------------------
// Step 2: Create the client
// --------------------------------------------------------------

// TS: Creating an instance of a class needs the `new` keyword:
// `new OpenAI(...)`.
//
// The argument is an options object (see 1-basic.ts), and the `? :` picks
// which one to pass. The option names are camelCase (`apiKey`, `baseURL`),
// the usual style for names in TypeScript.
//
// Ollama does not check API keys, but the client refuses to start without
// one, so it gets a placeholder.
//
// `maxRetries: 0` stops the client from silently sending a failed request
// again (it does that twice by default). Over the internet a second try often
// helps. On your own computer it would give the same result, and after a
// request that ran for minutes it would only make you wait several times as
// long for the error.
//
// TS: A module's code runs only ONCE, however many files import it. So every
// script that imports `client` gets this same object.
export const client = new OpenAI(
  provider === "openai"
    ? { apiKey: openaiApiKey }
    : { baseURL: ollamaBaseUrl, apiKey: "ollama", maxRetries: 0 },
);

// --------------------------------------------------------------
// Step 3: Choose the model for each request
// --------------------------------------------------------------

/** The model-related settings of one chat request. */
// TS: `interface` describes the shape of an object: which keys it has and the
// type of each value.
//
// TS: The `?` after a key makes it OPTIONAL: the key may be left out
// completely. `{ model: "gpt-4o" }` is a valid ModelOptions.
//
// TS: `"none"` used as a type means "exactly this string and no other".
interface ModelOptions {
  model: string;
  // snake_case because this is the API's own field name, sent as it is.
  reasoning_effort?: "none";
  temperature?: number;
}

/**
 * Returns the model settings for one request. The scripts name the OpenAI
 * model they want, and this function swaps in the local model when Ollama is
 * in use.
 *
 * @param openaiModel The model to use with OpenAI, for example "gpt-4o"
 */
export function modelOptions(openaiModel: string): ModelOptions {
  if (provider === "openai") {
    return { model: openaiModel };
  }

  // qwen3.5 is a "thinking" model. By default it writes out a long chain of
  // reasoning before it answers, which on an ordinary computer turns a reply
  // of a few seconds into one of several minutes. `reasoning_effort: "none"`
  // switches the thinking off. Models that cannot think ignore the setting.
  //
  // `temperature` controls how much randomness goes into each word the model
  // picks. A small local model at its default setting sometimes skips a tool
  // call or misjudges a request, and gets it right on the next run. With 0 it
  // always picks its most likely answer, so every run gives the same result.
  return { model: ollamaModel, reasoning_effort: "none", temperature: 0 };
}

// --------------------------------------------------------------
// Step 4: With Ollama, check that it is ready before the script starts
// --------------------------------------------------------------

/**
 * Makes sure Ollama is running and has the model. Without this check, a setup
 * problem only shows up later as a vague "Connection error." from the client.
 */
// TS: `async` lets a function use `await` (both are explained in 1-basic.ts
// and 3-tools.ts). `Promise<void>` means "finishes later, returns nothing".
async function checkOllamaIsReady(): Promise<void> {
  // TS: `let` instead of `const`, because the value is assigned further down,
  // inside the `try`. With no starting value to infer a type from, the
  // annotation states what may be assigned. `string[]` means "an array of
  // strings".
  let installedModels: string[];

  // TS: `try` runs code that may throw an error. If it does, the `catch`
  // block runs and receives that error.
  try {
    // Ollama also answers OpenAI's "list models" request.
    const page = await client.models.list();

    // TS: `.map(fn)` builds a new array by calling `fn` on every element.
    // `(installed) => installed.id` is an arrow function (see
    // src/lib/logger.ts): it takes one element and returns its `id`.
    installedModels = page.data.map((installed) => installed.id);
  } catch (error) {
    // TS: `{ cause: error }` attaches the original error to the new one, so
    // both are shown when the program stops.
    throw new Error(
      `Could not reach Ollama at ${ollamaBaseUrl}. Open the Ollama app (or run "ollama serve") and try again. ` +
        "To use OpenAI instead, put your OPENAI_API_KEY in the .env file.",
      { cause: error },
    );
  }

  // Ollama reads a model name without a tag as "<name>:latest", and it does
  // not care about upper or lower case.
  const wantedModel = ollamaModel.includes(":") ? ollamaModel : `${ollamaModel}:latest`;

  // TS: `.some(fn)` is true when `fn` is true for at least one element.
  const isInstalled = installedModels.some(
    (name) => name.toLowerCase() === wantedModel.toLowerCase(),
  );

  if (!isInstalled) {
    throw new Error(
      `Ollama has no model named "${ollamaModel}". Installed models: ${installedModels.join(", ") || "none"}. ` +
        `Set OLLAMA_MODEL in the .env file to one of those, or download this one with: ollama pull ${ollamaModel}`,
    );
  }
}

if (provider === "ollama") {
  await checkOllamaIsReady();
  logger.info(`No OPENAI_API_KEY found, using the local Ollama model "${ollamaModel}"`);
}
