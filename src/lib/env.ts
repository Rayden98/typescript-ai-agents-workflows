/**
 * Loads environment variables (OPENAI_API_KEY and the optional Ollama
 * settings) from a `.env` file.
 *
 * src/lib/llm.ts starts with `import "./env";` so the settings are available
 * before it creates the client.
 */

// TS: The `node:` prefix marks a module that ships with Node itself (Node's
// standard library), as opposed to a package installed from npm.
// The curly braces make this a NAMED import: we pick one export by its name.
import { fileURLToPath } from "node:url";

// TS: No curly braces = a DEFAULT import: the single main thing a module
// exports. We choose the local name ourselves (`dotenv`).
import dotenv from "dotenv";

// TS: `import.meta.url` is the location of THIS file, written as a URL:
//   file:///C:/.../src/lib/env.ts
//
// `new URL(relativePath, base)` resolves a relative path against a base. This
// file is in src/lib, so "../../.env" is the `.env` in the project folder.
// Building the path from this file (instead of from the folder you happen to
// run the command in) means the scripts work no matter what your current
// directory is.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));

// If the file doesn't exist it is skipped, and variables already set in your
// shell are never overwritten.
dotenv.config({
  path: envFile,
  quiet: true, // don't print a "loaded N variables" banner on every run
});

// TS: This file has no `export`s. It is imported only for its SIDE EFFECT
// (filling in `process.env`), which is why the import in src/lib/llm.ts has no
// names in it: `import "./env";`
