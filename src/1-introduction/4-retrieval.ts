/**
 * 4 - Retrieval: the same tool pattern as 3-tools.ts, but the tool looks up
 * information in a knowledge base and the model answers from it.
 *
 * Run it with: npm run intro:retrieval
 * Docs:        https://platform.openai.com/docs/guides/function-calling
 *
 * New TypeScript ideas in this file:
 *   reading files, nested schemas, unused parameters (`_name`),
 *   why a `const` can't be reused for a second conversation
 */

// TS: `node:fs/promises` is Node's file-system module in its Promise flavour,
// so `readFile` can be awaited.
import { readFile } from "node:fs/promises";

import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources";
import { z } from "zod";

import { client, modelOptions } from "../lib/llm";
import { getParsedOrThrow } from "../lib/structured-output";

// --------------------------------------------------------------
// Define the knowledge base retrieval tool
// --------------------------------------------------------------

// The shape of kb.json. Schemas nest: an object containing an array of objects.
const KnowledgeBase = z.object({
  records: z.array(
    z.object({
      id: z.number(),
      question: z.string(),
      answer: z.string(),
    }),
  ),
});
type KnowledgeBase = z.infer<typeof KnowledgeBase>;

/**
 * Load the whole knowledge base from the JSON file.
 * (This is a mock function for demonstration purposes, we don't search)
 */
// TS: The parameter is never used, because this mock returns everything. Our
// tsconfig reports unused parameters as errors (`noUnusedParameters`), and a
// leading underscore is the standard way to say "unused on purpose".
async function searchKb(_question: string): Promise<KnowledgeBase> {
  // Resolving the path against this file's own location (`import.meta.url`,
  // see src/lib/env.ts) means the script finds kb.json no matter which folder
  // you run it from.
  const kbFile = new URL("./kb.json", import.meta.url);

  // `readFile` opens, reads and closes the file in one call.
  const text = await readFile(kbFile, "utf8");

  // `JSON.parse` returns `any`, so we validate it into a real type right away.
  return KnowledgeBase.parse(JSON.parse(text));
}

// --------------------------------------------------------------
// Step 1: Call model with search_kb tool defined
// --------------------------------------------------------------

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_kb",
      description: "Get the answer to the user's question from the knowledge base.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

const SearchKbArgs = z.object({ question: z.string() });

const systemPrompt =
  "You are a helpful assistant that answers questions from the knowledge base about our e-commerce store.";

const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: "What is the return policy?" },
];

const completion = await client.chat.completions.create({
  ...modelOptions("gpt-4o"),
  messages,
  tools,
});

// --------------------------------------------------------------
// Step 2: Model decides to call function(s)
// --------------------------------------------------------------

console.dir(completion, { depth: null });

// --------------------------------------------------------------
// Step 3: Execute search_kb function
// --------------------------------------------------------------

async function callFunction(name: string, args: unknown): Promise<unknown> {
  if (name === "search_kb") {
    const { question } = SearchKbArgs.parse(args);
    return searchKb(question);
  }
  throw new Error(`Unknown tool: ${name}`);
}

const assistantMessage = completion.choices[0]?.message;
if (!assistantMessage) {
  throw new Error("The model returned no choices.");
}
messages.push(assistantMessage);

for (const toolCall of assistantMessage.tool_calls ?? []) {
  if (toolCall.type !== "function") {
    continue;
  }

  const name = toolCall.function.name;
  const args: unknown = JSON.parse(toolCall.function.arguments);

  const result = await callFunction(name, args);
  messages.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify(result),
  });
}

// --------------------------------------------------------------
// Step 4: Supply result and call model again
// --------------------------------------------------------------

const KBResponse = z.object({
  answer: z.string().describe("The answer to the user's question."),
  // `z.int()` is a whole number. Its TypeScript type is still `number`, since
  // there is no separate int type, but the model is told to send an integer and
  // Zod rejects 1.5.
  source: z.int().describe("The record id of the answer."),
});

const completion2 = await client.chat.completions.parse({
  ...modelOptions("gpt-4o"),
  messages,
  tools,
  response_format: zodResponseFormat(KBResponse, "KBResponse"),
});

// --------------------------------------------------------------
// Step 5: Check model response
// --------------------------------------------------------------

const finalResponse = getParsedOrThrow(completion2);
console.log(finalResponse.answer);
console.log(finalResponse.source);

// --------------------------------------------------------------
// Question that doesn't trigger the tool
// --------------------------------------------------------------

// TS: We can't reuse the name `messages` for the new conversation: it is a
// `const`, and reassigning a const is a compile error. A second variable with
// a clearer name is the usual answer, and it also keeps the first
// conversation intact.
const offTopicMessages: ChatCompletionMessageParam[] = [
  { role: "system", content: systemPrompt },
  { role: "user", content: "What is the weather in Tokyo?" },
];

const completion3 = await client.chat.completions.create({
  ...modelOptions("gpt-4o"),
  messages: offTopicMessages,
  tools,
});

// The knowledge base has nothing about weather, so the model answers in plain
// text instead of calling the tool.
console.log(completion3.choices[0]?.message.content);
