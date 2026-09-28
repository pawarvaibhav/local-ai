import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { complete, MODEL } from "./lib/ollama.mjs";
import { runLocalAgent } from "./lib/agent.mjs";
import { logSavings, categorize } from "./lib/costlog.mjs";

const execFileAsync = promisify(execFile);

const server = new McpServer({ name: "local-ai", version: "1.0.0" });

server.registerTool(
  "ask_local",
  {
    title: "Ask local model",
    description:
      "Send a general question/research prompt to the local Ollama model instead of doing it yourself. Good for simple Q&A, drafting text, or anything that doesn't need file/shell access. Returns the model's answer.",
    inputSchema: {
      prompt: z.string().describe("The question or task to hand to the local model."),
      system: z.string().optional().describe("Optional system prompt / role instructions."),
    },
  },
  async ({ prompt, system }) => {
    const { text, promptTokens, completionTokens } = await complete(prompt, { system });
    await logSavings({ tool: "ask_local", category: categorize("ask_local"), detail: prompt, promptTokens, completionTokens });
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "summarize_file",
  {
    title: "Summarize a file locally",
    description:
      "Read a (potentially large) file and have the local model summarize/digest it instead of you reading the whole thing. Optionally focus on a specific question.",
    inputSchema: {
      path: z.string().describe("Absolute or relative (to cwd) path to the file."),
      question: z.string().optional().describe("Optional specific question to answer about the file."),
    },
  },
  async ({ path: filePath, question }) => {
    const abs = path.resolve(filePath);
    const content = await fs.readFile(abs, "utf8");
    const prompt = question
      ? `Here is the content of ${abs}:\n\n${content}\n\n---\nAnswer this about the file: ${question}`
      : `Summarize the following file (${abs}) concisely, covering its purpose and key structure:\n\n${content}`;
    const { text, promptTokens, completionTokens } = await complete(prompt, {
      system: "You are a careful code/document summarizer. Be concise and factual.",
    });
    await logSavings({ tool: "summarize_file", category: categorize("summarize_file"), detail: abs, promptTokens, completionTokens });
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "search_explain",
  {
    title: "Bulk search + explain",
    description:
      "Grep a directory for a pattern and have the local model explain/summarize the matches, instead of you reading each file. Good for 'where is X used and why' across a codebase.",
    inputSchema: {
      pattern: z.string().describe("Regex or literal pattern to search for (ripgrep syntax)."),
      dir: z.string().optional().describe("Directory to search (default: cwd)."),
      question: z.string().optional().describe("What you actually want to know from the results."),
    },
  },
  async ({ pattern, dir, question }) => {
    const searchDir = path.resolve(dir || ".");
    let matches;
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-n", "--max-count=5", "-C", "1", pattern, searchDir],
        { maxBuffer: 5 * 1024 * 1024 }
      );
      matches = stdout;
    } catch (err) {
      matches = err.stdout || `(no matches or error: ${err.message})`;
    }
    if (!matches.trim()) {
      return { content: [{ type: "text", text: `No matches for "${pattern}" in ${searchDir}.` }] };
    }
    const prompt = `These are ripgrep matches for pattern "${pattern}" in ${searchDir}:\n\n${matches.slice(0, 20000)}\n\n---\n${
      question || "Summarize where/how this is used and anything notable."
    }`;
    const { text, promptTokens, completionTokens } = await complete(prompt, {
      system: "You are a careful code analyst. Reference file:line when relevant. Be concise.",
    });
    await logSavings({ tool: "search_explain", category: categorize("search_explain"), detail: `"${pattern}" in ${searchDir}`, promptTokens, completionTokens });
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "local_agent_run",
  {
    title: "Run local coding agent (build/test/validate)",
    description:
      "Hand a coding task to the local model as an autonomous agent with file + shell access scoped to `cwd`. It will make the changes, then build/run tests/validate them itself, iterating on failures, before reporting back. Use for self-contained implementation tasks (boilerplate, CRUD, tests, config, scripted fixes) so you don't burn your own turns on the mechanical build/fix/test loop. Review its diff/report before trusting it fully.",
    inputSchema: {
      task: z.string().describe("Clear description of what to build/change and how to validate it (e.g. which test/build command to run)."),
      cwd: z.string().describe("Absolute path to the project directory the agent is allowed to touch. It cannot escape this directory."),
      max_steps: z.number().int().positive().max(60).optional(),
      max_minutes: z.number().positive().max(30).optional(),
    },
  },
  async ({ task, cwd, max_steps, max_minutes }) => {
    const abs = path.resolve(cwd);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      return { content: [{ type: "text", text: `ERROR: cwd does not exist or is not a directory: ${abs}` }], isError: true };
    }
    const result = await runLocalAgent({
      task,
      cwd: abs,
      maxSteps: max_steps ?? 25,
      maxMs: (max_minutes ?? 10) * 60 * 1000,
    });
    await logSavings({
      tool: "local_agent_run",
      category: categorize("local_agent_run", task),
      detail: task,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      steps: result.steps,
    });
    const summary = [
      `success: ${result.success}`,
      `steps: ${result.steps}`,
      `report: ${result.report}`,
      ``,
      `--- trace ---`,
      ...result.log,
    ].join("\n");
    return { content: [{ type: "text", text: summary.slice(0, 30000) }] };
  }
);

server.registerTool(
  "local_ai_status",
  {
    title: "Local AI status",
    description: "Check whether Ollama and the local model are reachable and report the active model name.",
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${process.env.OLLAMA_HOST || "http://localhost:11434"}/api/version`);
      const v = await res.json();
      return { content: [{ type: "text", text: `Ollama version ${v.version}, model=${MODEL}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Ollama unreachable: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
