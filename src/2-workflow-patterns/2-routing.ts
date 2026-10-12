/**
 * Workflow 2 - Routing: one LLM call classifies the request, then we send it
 * to a specialised handler.
 *
 *     user input -> router -> new event handler
 *                          -> modify event handler
 *                          -> (anything else: stop)
 *
 * Run it with: npm run workflow:routing
 *
 * New TypeScript ideas in this file:
 *   `z.enum` and literal union types, `interface`, returning plain objects,
 *   `switch` with exhaustiveness checking
 */

import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { client, modelOptions } from "../lib/llm";
import { logger } from "../lib/logger";
import { getParsedOrThrow } from "../lib/structured-output";

const model = "gpt-4o";

// --------------------------------------------------------------
// Step 1: Define the data models for routing and responses
// --------------------------------------------------------------

/** Router LLM call: Determine the type of calendar request */
const CalendarRequestType = z.object({
  // TS: `z.enum([...])` allows only these exact strings.
  // The inferred TypeScript type is a union of string literals:
  //     "new_event" | "modify_event" | "other"
  // so comparing `requestType` to a misspelled value such as "new_evnt" is a
  // compile error, not a silent bug.
  requestType: z
    .enum(["new_event", "modify_event", "other"])
    .describe("Type of calendar request being made"),
  confidenceScore: z.number().describe("Confidence score between 0 and 1"),
  description: z.string().describe("Cleaned description of the request"),
});
type CalendarRequestType = z.infer<typeof CalendarRequestType>;

// TS: The next three schemas have no matching `type X = z.infer<...>` line. We
// only need a named type when we write it in an annotation somewhere, and
// these are only ever passed to `zodResponseFormat`. TypeScript still infers
// the shape of the parsed result where it is used.

/** Details for creating a new event */
const NewEventDetails = z.object({
  name: z.string().describe("Name of the event"),
  date: z.string().describe("Date and time of the event (ISO 8601)"),
  durationMinutes: z.int().describe("Duration in minutes"),
  participants: z.array(z.string()).describe("List of participants"),
});

/** Details for changing an existing event */
const Change = z.object({
  field: z.string().describe("Field to change"),
  newValue: z.string().describe("New value for the field"),
});

/** Details for modifying an existing event */
const ModifyEventDetails = z.object({
  eventIdentifier: z.string().describe("Description to identify the existing event"),
  // Schemas compose: an array of the `Change` schema defined above.
  changes: z.array(Change).describe("List of changes to make"),
  participantsToAdd: z.array(z.string()).describe("New participants to add"),
  participantsToRemove: z.array(z.string()).describe("Participants to remove"),
});

/** Final response format */
// TS: This one is never sent to the model and never validated: our own code
// builds it. So no runtime schema is needed, and a plain compile-time type
// does the job.
//
// `interface` describes the shape of an object. For objects it is
// interchangeable with `type X = { ... }`; pick one style and stay with it.
//
// Rule of thumb for this project:
//   data crossing a boundary (LLM, HTTP, files)  -> Zod schema + z.infer
//   data our own code creates                    -> interface / type
interface CalendarResponse {
  success: boolean;
  message: string;
  calendarLink: string | null;
}

// --------------------------------------------------------------
// Step 2: Define the routing and processing functions
// --------------------------------------------------------------

/** Router LLM call to determine the type of calendar request */
async function routeCalendarRequest(userInput: string): Promise<CalendarRequestType> {
  logger.info("Routing calendar request");

  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content:
          "Determine if this is a request to create a new calendar event or modify an existing one.",
      },
      { role: "user", content: userInput },
    ],
    response_format: zodResponseFormat(CalendarRequestType, "CalendarRequestType"),
  });
  const result = getParsedOrThrow(completion);

  logger.info(
    `Request routed as: ${result.requestType} with confidence: ${result.confidenceScore}`,
  );
  return result;
}

/** Process a new event request */
async function handleNewEvent(description: string): Promise<CalendarResponse> {
  logger.info("Processing new event request");

  // Get event details
  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content: "Extract details for creating a new calendar event.",
      },
      { role: "user", content: description },
    ],
    response_format: zodResponseFormat(NewEventDetails, "NewEventDetails"),
  });
  const details = getParsedOrThrow(completion);

  // `JSON.stringify(value, null, 2)` writes the JSON over several indented
  // lines. The middle argument (`null`) is a rarely used filter; the `2` is
  // the indentation.
  logger.info(`New event: ${JSON.stringify(details, null, 2)}`);

  // Generate response
  // TS: No class to instantiate. We return a plain object, and because the
  // function's return type is `Promise<CalendarResponse>`, TypeScript checks
  // the object against the interface: a missing key, an extra key or a wrong
  // value type is an error. This is STRUCTURAL TYPING: an object "is a"
  // CalendarResponse if it has the right shape, no matter how it was created.
  return {
    success: true,
    message: `Created new event '${details.name}' for ${details.date} with ${details.participants.join(", ")}`,
    calendarLink: `calendar://new?event=${details.name}`,
  };
}

/** Process an event modification request */
async function handleModifyEvent(description: string): Promise<CalendarResponse> {
  logger.info("Processing event modification request");

  // Get modification details
  const completion = await client.chat.completions.parse({
    ...modelOptions(model),
    messages: [
      {
        role: "system",
        content: "Extract details for modifying an existing calendar event.",
      },
      { role: "user", content: description },
    ],
    response_format: zodResponseFormat(ModifyEventDetails, "ModifyEventDetails"),
  });
  const details = getParsedOrThrow(completion);

  logger.info(`Modified event: ${JSON.stringify(details, null, 2)}`);

  // Generate response
  return {
    success: true,
    message: `Modified event '${details.eventIdentifier}' with the requested changes`,
    calendarLink: `calendar://modify?event=${details.eventIdentifier}`,
  };
}

/** Main function implementing the routing workflow */
async function processCalendarRequest(userInput: string): Promise<CalendarResponse | null> {
  logger.info("Processing calendar request");

  // Route the request
  const routeResult = await routeCalendarRequest(userInput);

  // Check confidence threshold
  if (routeResult.confidenceScore < 0.7) {
    logger.warning(`Low confidence score: ${routeResult.confidenceScore}`);
    return null;
  }

  // Route to appropriate handler
  // TS: A `switch` on a literal union gets an extra safety net: TypeScript
  // knows the three `case`s cover every possible value, so it accepts that
  // the function always returns. If you later add "cancel_event" to the
  // `z.enum` above and forget to handle it here, this function stops
  // compiling ("Function lacks ending return statement") and points you at
  // the gap. That is called EXHAUSTIVENESS CHECKING.
  switch (routeResult.requestType) {
    case "new_event":
      return handleNewEvent(routeResult.description);
    case "modify_event":
      return handleModifyEvent(routeResult.description);
    case "other":
      logger.warning("Request type not supported");
      return null;
  }
}

// --------------------------------------------------------------
// Step 3: Test with new event
// --------------------------------------------------------------

const newEventInput = "Let's schedule a team meeting next Tuesday at 2pm with Alice and Bob";
const newEventResult = await processCalendarRequest(newEventInput);
if (newEventResult) {
  console.log(`Response: ${newEventResult.message}`);
}

// --------------------------------------------------------------
// Step 4: Test with modify event
// --------------------------------------------------------------

const modifyEventInput =
  "Can you move the team meeting with Alice and Bob to Wednesday at 3pm instead?";
const modifyEventResult = await processCalendarRequest(modifyEventInput);
if (modifyEventResult) {
  console.log(`Response: ${modifyEventResult.message}`);
}

// --------------------------------------------------------------
// Step 5: Test with invalid request
// --------------------------------------------------------------

const invalidInput = "What's the weather like today?";
const invalidResult = await processCalendarRequest(invalidInput);
if (!invalidResult) {
  console.log("Request not recognized as a calendar operation");
}
