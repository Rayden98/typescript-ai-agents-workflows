/**
 * Workflow 1 - Prompt chaining: break a task into a sequence of LLM calls,
 * each one working on the previous one's output, with a gate check in between.
 *
 *     user input -> extract -> [gate] -> parse details -> confirmation
 *
 * Run it with: npm run workflow:chaining
 *
 * New TypeScript ideas in this file:
 *   `.nullable()` vs optional, functions that return `T | null`,
 *   number formatting, `!` and `||`
 */

import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { client, modelOptions } from "../lib/llm";
import { logger } from "../lib/logger";
import { getParsedOrThrow } from "../lib/structured-output";

// The OpenAI model for every call in this file. Each call passes it through
// `modelOptions(model)`, which swaps in your local model when Ollama is in use.
const model = "gpt-4o";

// --------------------------------------------------------------
// Step 1: Define the data models for each stage
// --------------------------------------------------------------

// A note on names: the keys below are what the model is asked to produce.
// They are camelCase because that is the TypeScript convention for property
// names.

/** First LLM call: Extract basic event information */
const EventExtraction = z.object({
  description: z.string().describe("Raw description of the event"),
  isCalendarEvent: z.boolean().describe("Whether this text describes a calendar event"),
  confidenceScore: z.number().describe("Confidence score between 0 and 1"),
});
type EventExtraction = z.infer<typeof EventExtraction>;

/** Second LLM call: Parse specific event details */
const EventDetails = z.object({
  name: z.string().describe("Name of the event"),
  date: z
    .string()
    .describe("Date and time of the event. Use ISO 8601 to format this value."),
  durationMinutes: z.int().describe("Expected duration in minutes"),
  participants: z.array(z.string()).describe("List of participants"),
});
type EventDetails = z.infer<typeof EventDetails>;

/** Third LLM call: Generate confirmation message */
const EventConfirmation = z.object({
  confirmationMessage: z.string().describe("Natural language confirmation message"),
  // TS: `.nullable()` makes the type `string | null`.
  //
  // TypeScript has TWO ways to say "this might be missing", and they differ:
  //   calendarLink: string | null   the key is always there, the value may be null
  //   calendarLink?: string         the key itself may be absent (-> undefined)
  // OpenAI's structured output requires every key to be present, so "no value"
  // has to be written as null. That is why this is `.nullable()` and not
  // `.optional()`.
  calendarLink: z.string().nullable().describe("Generated calendar link if applicable"),
});
type EventConfirmation = z.infer<typeof EventConfirmation>;

// --------------------------------------------------------------
// Step 2: Define the functions
// --------------------------------------------------------------

/** Builds the sentence that tells the model today's date, e.g. "Today is Saturday, October 10, 2026." */
function getDateContext(): string {
  // JavaScript has no format strings for dates. You describe the parts you
  // want and `toLocaleDateString` arranges them for the given language.
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
  return `Today is ${today}.`;
}

/** First LLM call to determine if input is a calendar event */
// TS: The return type says exactly what callers get: an EventExtraction, later.
async function extractEventInfo(userInput: string): Promise<EventExtraction> {
  logger.info("Starting event extraction analysis");
  logger.debug(`Input text: ${userInput}`);

  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content: `${getDateContext()} Analyze if the text describes a calendar event.`,
      },
      { role: "user", content: userInput },
    ],
    response_format: zodResponseFormat(EventExtraction, "EventExtraction"),
  });

  // TS: `getParsedOrThrow` is generic, so `result` is typed as EventExtraction
  // here and as EventDetails in the next function, without us saying so.
  const result = getParsedOrThrow(completion);

  // `.toFixed(2)` formats a number with two decimals.
  logger.info(
    `Extraction complete - Is calendar event: ${result.isCalendarEvent}, Confidence: ${result.confidenceScore.toFixed(2)}`,
  );
  return result;
}

/** Second LLM call to extract specific event details */
async function parseEventDetails(description: string): Promise<EventDetails> {
  logger.info("Starting event details parsing");

  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content: `${getDateContext()} Extract detailed event information. When dates reference 'next Tuesday' or similar relative dates, use this current date as reference.`,
      },
      { role: "user", content: description },
    ],
    response_format: zodResponseFormat(EventDetails, "EventDetails"),
  });
  const result = getParsedOrThrow(completion);

  logger.info(
    `Parsed event details - Name: ${result.name}, Date: ${result.date}, Duration: ${result.durationMinutes}min`,
  );
  // `array.join(", ")` joins the elements into one string, with ", " between
  // them.
  logger.debug(`Participants: ${result.participants.join(", ")}`);
  return result;
}

/** Third LLM call to generate a confirmation message */
// TS: Because the parameter is typed `EventDetails`, calling this with
// anything else (say, the EventExtraction from step one) is a compile error.
async function generateConfirmation(eventDetails: EventDetails): Promise<EventConfirmation> {
  logger.info("Generating confirmation message");

  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content:
          "Generate a natural confirmation message for the event. Sign of with your name; Susie",
      },
      { role: "user", content: JSON.stringify(eventDetails) },
    ],
    response_format: zodResponseFormat(EventConfirmation, "EventConfirmation"),
  });
  const result = getParsedOrThrow(completion);

  logger.info("Confirmation message generated successfully");
  return result;
}

// --------------------------------------------------------------
// Step 3: Chain the functions together
// --------------------------------------------------------------

/** Main function implementing the prompt chain with gate check */
// TS: `EventConfirmation | null` means "an EventConfirmation, or null".
// The `| null` is part of the contract: every caller is forced by the
// compiler to handle the "not a calendar request" case.
async function processCalendarRequest(userInput: string): Promise<EventConfirmation | null> {
  logger.info("Processing calendar request");
  logger.debug(`Raw input: ${userInput}`);

  // First LLM call: Extract basic info
  const initialExtraction = await extractEventInfo(userInput);

  // Gate check: Verify if it's a calendar event with sufficient confidence
  // TS: `!` means "not", `||` means "or", `&&` means "and".
  if (!initialExtraction.isCalendarEvent || initialExtraction.confidenceScore < 0.7) {
    logger.warning(
      `Gate check failed - is_calendar_event: ${initialExtraction.isCalendarEvent}, confidence: ${initialExtraction.confidenceScore.toFixed(2)}`,
    );
    return null;
  }

  logger.info("Gate check passed, proceeding with event processing");

  // Second LLM call: Get detailed event information
  const eventDetails = await parseEventDetails(initialExtraction.description);

  // Third LLM call: Generate confirmation
  const confirmation = await generateConfirmation(eventDetails);

  logger.info("Calendar request processing completed successfully");
  return confirmation;
}

// Both tests below print their result the same way. A small function keeps
// that in one place.
function printResult(result: EventConfirmation | null): void {
  // TS: Narrowing again. Inside the `if`, `result` is an EventConfirmation.
  // In the `else` branch TypeScript knows it can only be `null`.
  if (result) {
    console.log(`Confirmation: ${result.confirmationMessage}`);
    // `calendarLink` is `string | null`, so it needs its own check too.
    if (result.calendarLink) {
      console.log(`Calendar Link: ${result.calendarLink}`);
    }
  } else {
    console.log("This doesn't appear to be a calendar event request.");
  }
}

// --------------------------------------------------------------
// Step 4: Test the chain with a valid input
// --------------------------------------------------------------

const validInput =
  "Let's schedule a 1h team meeting next Tuesday at 2pm with Alice and Bob to discuss the project roadmap.";

printResult(await processCalendarRequest(validInput));

// --------------------------------------------------------------
// Step 5: Test the chain with an invalid input
// --------------------------------------------------------------

const invalidInput = "Can you send an email to Alice and Bob to discuss the project roadmap?";

printResult(await processCalendarRequest(invalidInput));
