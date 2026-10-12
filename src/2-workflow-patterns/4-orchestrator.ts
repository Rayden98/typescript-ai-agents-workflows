/**
 * Workflow 4 - Orchestrator-workers: one LLM call plans the work, several
 * "worker" calls each do a piece of it, and a final call reviews the result.
 * Here: plan a blog post, write it section by section, then polish it.
 *
 *     topic -> orchestrator (plan) -> worker per section -> reviewer
 *
 * Run it with: npm run workflow:orchestrator
 *
 * New TypeScript ideas in this file:
 *   classes (`private`, `readonly`, `this`), `Map<K, V>`, default parameter
 *   values, typed return objects, `.map()` with arrow functions,
 *   prompt templates as functions
 */

import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { client, modelOptions, usingLocalModel } from "../lib/llm";
import { logger } from "../lib/logger";
import { getParsedOrThrow } from "../lib/structured-output";

const model = "gpt-4o-mini";

// --------------------------------------------------------------
// Step 1: Define the data models
// --------------------------------------------------------------

/** Blog section task defined by orchestrator */
const SubTask = z.object({
  sectionType: z.string().describe("Type of blog section to write"),
  description: z.string().describe("What this section should cover"),
  styleGuide: z.string().describe("Writing style for this section"),
  targetLength: z.int().describe("Target word count for this section"),
});
type SubTask = z.infer<typeof SubTask>;

/** Orchestrator's blog structure and tasks */
const OrchestratorPlan = z.object({
  topicAnalysis: z.string().describe("Analysis of the blog topic"),
  targetAudience: z.string().describe("Intended audience for the blog"),
  sections: z.array(SubTask).describe("List of sections to write"),
});
type OrchestratorPlan = z.infer<typeof OrchestratorPlan>;

/** Content written by a worker */
const SectionContent = z.object({
  content: z.string().describe("Written content for the section"),
  keyPoints: z.array(z.string()).describe("Main points covered"),
});
type SectionContent = z.infer<typeof SectionContent>;

/** Suggested edits for a section */
const SuggestedEdits = z.object({
  sectionName: z.string().describe("Name of the section"),
  suggestedEdit: z.string().describe("Suggested edit"),
});

/** Final review and suggestions */
const ReviewFeedback = z.object({
  cohesionScore: z.number().describe("How well sections flow together (0-1)"),
  suggestedEdits: z.array(SuggestedEdits).describe("Suggested edits by section"),
  finalVersion: z.string().describe("Complete, polished blog post"),
});
type ReviewFeedback = z.infer<typeof ReviewFeedback>;

/** Everything `writeBlog` returns. */
// TS: With this interface, `result.review.finalVersion` autocompletes and a
// typo such as `result.reveiw` is a compile error.
interface BlogResult {
  structure: OrchestratorPlan;
  sections: Map<string, SectionContent>;
  review: ReviewFeedback;
}

// --------------------------------------------------------------
// Step 2: Define prompts
// --------------------------------------------------------------

// TS: A template literal fills its `${...}` slots immediately, so a prompt
// with blanks to fill in later is written as a FUNCTION that takes the values
// and returns the finished string. The bonus is type checking: every value
// the prompt needs is a required, typed parameter, and a parameter that is
// never used gets flagged.

function orchestratorPrompt(topic: string, targetLength: number, style: string): string {
  return `
Analyze this blog topic and break it down into logical sections.

Topic: ${topic}
Target Length: ${targetLength} words
Style: ${style}

Return your response in this format:

# Analysis
Analyze the topic and explain how it should be structured.
Consider the narrative flow and how sections will work together.

# Target Audience
Define the target audience and their interests/needs.

# Sections
## Section 1
- Type: section_type
- Description: what this section should cover
- Style: writing style guidelines

[Additional sections as needed...]
`;
}

function workerPrompt(topic: string, section: SubTask, previousSections: string): string {
  return `
Write a blog section based on:
Topic: ${topic}
Section Type: ${section.sectionType}
Section Goal: ${section.description}
Style Guide: ${section.styleGuide}
Target Length: ${section.targetLength} words

Previous Sections:
${previousSections}

Return your response in this format:

# Content
[Your section content here, following the style guide]

# Key Points
- Main point 1
- Main point 2
[Additional points as needed...]
`;
}

function reviewerPrompt(topic: string, audience: string, sections: string): string {
  return `
Review this blog post for cohesion and flow:

Topic: ${topic}
Target Audience: ${audience}

Sections:
${sections}

Provide a cohesion score between 0.0 and 1.0, suggested edits for each section if needed, and a final polished version of the complete post.

The cohesion score should reflect how well the sections flow together, with 1.0 being perfect cohesion.
For suggested edits, focus on improving transitions and maintaining consistent tone across sections.
The final version should incorporate your suggested improvements into a polished, cohesive blog post.
`;
}

// --------------------------------------------------------------
// Step 3: Implement orchestrator
// --------------------------------------------------------------

class BlogOrchestrator {
  // TS: Fields are declared at the top of the class body, with their initial
  // value. No constructor is needed when there is nothing else to set up.
  //
  // TS: `private` means only code inside this class may touch the field, and
  // the compiler enforces it.
  //
  // TS: `readonly` means the field can never be reassigned to a different
  // Map. Adding entries to the Map is still fine (same idea as `const`).
  //
  // TS: `Map<string, SectionContent>` is a dictionary from string keys to
  // SectionContent values. A `Map` remembers the order in which entries were
  // added, and that order is the order of the blog's sections.
  private readonly sectionsContent = new Map<string, SectionContent>();

  /** Get orchestrator's blog structure plan */
  // TS: Methods are written without the `function` keyword. Inside a method,
  // the instance is `this`.
  async getPlan(topic: string, targetLength: number, style: string): Promise<OrchestratorPlan> {
    const completion = await client.chat.completions.parse({
      ...modelOptions(model),
      messages: [
        {
          role: "system",
          content: orchestratorPrompt(topic, targetLength, style),
        },
      ],
      response_format: zodResponseFormat(OrchestratorPlan, "OrchestratorPlan"),
    });
    return getParsedOrThrow(completion);
  }

  /**
   * Worker: Write a specific blog section with context from previous sections.
   *
   * @param topic The main blog topic
   * @param section SubTask containing section details
   * @returns The written content and key points
   */
  // TS: `@param` and `@returns` are JSDoc tags: they describe the parameters
  // and the return value. The types are not repeated in the comment because
  // the signature already states them.
  async writeSection(topic: string, section: SubTask): Promise<SectionContent> {
    // Create context from previously written sections
    // TS: `||` picks the right side when the left side is falsy. An empty
    // string is falsy, so this reads "the sections so far, or this fallback
    // text when there are none yet". (`??` would not work here: it only
    // reacts to null and undefined, and "" is neither.)
    const previousSections = this.formatSections() || "This is the first section.";

    const completion = await client.chat.completions.parse({
      ...modelOptions(model),
      messages: [
        {
          role: "system",
          content: workerPrompt(topic, section, previousSections),
        },
      ],
      response_format: zodResponseFormat(SectionContent, "SectionContent"),
    });
    return getParsedOrThrow(completion);
  }

  /** Reviewer: Analyze and improve overall cohesion */
  async reviewPost(topic: string, plan: OrchestratorPlan): Promise<ReviewFeedback> {
    const completion = await client.chat.completions.parse({
      ...modelOptions(model),
      messages: [
        {
          role: "system",
          content: reviewerPrompt(topic, plan.targetAudience, this.formatSections()),
        },
      ],
      response_format: zodResponseFormat(ReviewFeedback, "ReviewFeedback"),
    });
    return getParsedOrThrow(completion);
  }

  /** Process the entire blog writing task */
  // TS: `targetLength = 1000` is a DEFAULT PARAMETER VALUE, used when the
  // caller leaves that argument out. The types are inferred from the
  // defaults: `targetLength` is a number and `style` is a string, so no
  // annotation is needed on them.
  async writeBlog(topic: string, targetLength = 1000, style = "informative"): Promise<BlogResult> {
    logger.info(`Starting blog writing process for: ${topic}`);

    // Get blog structure plan
    const plan = await this.getPlan(topic, targetLength, style);
    // `.length` is a property, not a function call.
    logger.info(`Blog structure planned: ${plan.sections.length} sections`);
    logger.info(`Blog structure planned: ${JSON.stringify(plan, null, 2)}`);

    // Write each section
    // The sections are written one after another on purpose (an `await`
    // inside a loop), because each worker reads what the earlier ones wrote.
    for (const section of plan.sections) {
      logger.info(`Writing section: ${section.sectionType}`);
      const content = await this.writeSection(topic, section);
      // `.set(key, value)` adds an entry to the Map.
      this.sectionsContent.set(section.sectionType, content);
    }

    // Review and polish
    logger.info("Reviewing full blog post");
    const review = await this.reviewPost(topic, plan);

    return { structure: plan, sections: this.sectionsContent, review };
  }

  /** Joins every section written so far into one block of text. */
  // Both the worker and the reviewer need this string. A private helper
  // method keeps it in one place.
  private formatSections(): string {
    // TS: `.entries()` yields the Map's [key, value] pairs.
    // `Array.from` turns them into a real array so we can call `.map()`.
    // `.map(fn)` builds a new array by calling `fn` on each element.
    // `([sectionType, content]) => ...` is an arrow function that destructures
    // each [key, value] pair right in its parameter list.
    return Array.from(this.sectionsContent.entries())
      .map(([sectionType, content]) => `=== ${sectionType} ===\n${content.content}`)
      .join("\n\n");
  }
}

// --------------------------------------------------------------
// Step 4: Example usage
// --------------------------------------------------------------

const orchestrator = new BlogOrchestrator();

// Example: Technical blog post
const topic = "The impact of AI on software development";

// 1200 words is too much for a small local model: the reviewer has to read
// the whole post and then write all of it out again, and Ollama's default
// context window (4096 tokens for the prompt and the answer together) has no
// room for both. So on Ollama we ask for a shorter post.
const targetLength = usingLocalModel ? 400 : 1200;

// TS: Arguments are passed by position, so the order matters.
const result = await orchestrator.writeBlog(topic, targetLength, "technical but accessible");

console.log("\nFinal Blog Post:");
console.log(result.review.finalVersion);

// `console.log` accepts several arguments and prints them separated by
// spaces.
console.log("\nCohesion Score:", result.review.cohesionScore);
// No "is it empty?" check is needed first: looping over an empty array simply
// does nothing.
for (const edit of result.review.suggestedEdits) {
  console.log(`Section: ${edit.sectionName}`);
  console.log(`Suggested Edit: ${edit.suggestedEdit}`);
}
