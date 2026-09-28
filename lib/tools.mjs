import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Commands the local agent is never allowed to run, even inside its own sandbox root.
const DANGEROUS_PATTERNS = [
  /\bsudo\b/,
  /\brm\s+-rf\s+(\/|~)(\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bgit\s+push\s+[^\n]*(--force(-with-lease)?|-f)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+[^\n]*(--force|-f)\b/,
  /\bgit\s+clean\s+[^\n]*-[a-z]*f/,
  /\bgit\s+branch\s+(-D|--delete\s+--force)\b/,
  /\bgit\s+tag\s+[^\n]*(--force|-f)\b/,
  />\s*\/dev\/(disk|sd|rdisk)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
];

function resolveScoped(root, p) {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, p);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path escapes sandbox root (${root}): ${p}`);
  }
  return resolved;
}

export function buildTools(cwd) {
  const definitions = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file, path relative to the project root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write/overwrite a UTF-8 text file relative to the project root. Creates parent dirs as needed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files/dirs under a path relative to the project root.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_shell",
        description:
          "Run a shell command inside the project root (e.g. build, test, lint, run a script). 120s timeout. Use this to actually validate your work before finishing.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description:
          "Call this when the task is done (or you are stuck and cannot proceed). success must only be true if you actually ran build/tests and they passed.",
        parameters: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            report: { type: "string" },
          },
          required: ["success", "report"],
        },
      },
    },
  ];

  async function call(name, args) {
    switch (name) {
      case "read_file": {
        const p = resolveScoped(cwd, args.path);
        return await fs.readFile(p, "utf8");
      }
      case "write_file": {
        const p = resolveScoped(cwd, args.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, args.content ?? "", "utf8");
        return `wrote ${(args.content ?? "").length} bytes to ${args.path}`;
      }
      case "list_dir": {
        const p = resolveScoped(cwd, args.path || ".");
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)";
      }
      case "run_shell": {
        if (DANGEROUS_PATTERNS.some((re) => re.test(args.command))) {
          return `BLOCKED: command matched a safety rule and was not run: ${args.command}`;
        }
        try {
          const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-lc", args.command], {
            cwd: path.resolve(cwd),
            timeout: 120_000,
            maxBuffer: 5 * 1024 * 1024,
          });
          return `stdout:\n${stdout}\nstderr:\n${stderr}`;
        } catch (err) {
          return `command failed (exit ${err.code ?? "?"}):\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? err.message}`;
        }
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  return { definitions, call };
}
