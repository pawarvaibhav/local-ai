import { promises as fs, openSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailFile(p, maxBytes = 4000) {
  try {
    const content = readFileSync(p, "utf8");
    return content.length > maxBytes ? `...(truncated)...\n${content.slice(-maxBytes)}` : content;
  } catch (err) {
    return `(could not read log: ${err.message})`;
  }
}

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
  const bgProcs = new Map();
  let bgCounter = 0;

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
        name: "start_background",
        description:
          "Start a long-running command (a dev server, `npm start`, a static file server, etc.) in the background and return immediately. Use this instead of run_shell for anything meant to keep running — run_shell blocks until the command exits and will just time out on a server. Returns a process id you pass to check_process/stop_process.",
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
        name: "check_process",
        description: "Check whether a background process (started with start_background) is still running, and show the tail of its output log.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stop_process",
        description: "Stop a background process previously started with start_background.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_processes",
        description: "List all background processes started so far in this task, with their status.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description:
          "HTTP GET a local URL (localhost/127.0.0.1 only) to check that a page or service you started is actually responding, and see the rendered output/response body. Use this to verify a server works before calling finish.",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
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
      case "start_background": {
        if (DANGEROUS_PATTERNS.some((re) => re.test(args.command))) {
          return `BLOCKED: command matched a safety rule and was not run: ${args.command}`;
        }
        const id = `bg${++bgCounter}`;
        const logPath = path.join(os.tmpdir(), `local-agent-${id}-${Date.now()}.log`);
        const fd = openSync(logPath, "a");
        let child;
        try {
          child = spawn("/bin/zsh", ["-lc", args.command], {
            cwd: path.resolve(cwd),
            detached: true,
            stdio: ["ignore", fd, fd],
          });
        } finally {
          closeSync(fd);
        }
        child.unref();
        bgProcs.set(id, { pid: child.pid, command: args.command, logPath, stopped: false });
        return `started ${id} (pid ${child.pid}), logging to ${logPath}. Use check_process("${id}") to see if it's still running and read its output.`;
      }
      case "check_process": {
        const entry = bgProcs.get(args.id);
        if (!entry) return `ERROR: no background process with id ${args.id}`;
        const alive = !entry.stopped && isAlive(entry.pid);
        return `id=${args.id} pid=${entry.pid} command="${entry.command}" status=${alive ? "running" : "exited"}\n--- log tail ---\n${tailFile(entry.logPath)}`;
      }
      case "stop_process": {
        const entry = bgProcs.get(args.id);
        if (!entry) return `ERROR: no background process with id ${args.id}`;
        if (entry.stopped || !isAlive(entry.pid)) {
          entry.stopped = true;
          return `${args.id} was already stopped/exited.`;
        }
        try {
          process.kill(-entry.pid, "SIGTERM");
        } catch {
          try {
            process.kill(entry.pid, "SIGTERM");
          } catch (err) {
            return `ERROR stopping ${args.id}: ${err.message}`;
          }
        }
        entry.stopped = true;
        return `stopped ${args.id} (pid ${entry.pid})`;
      }
      case "list_processes": {
        if (bgProcs.size === 0) return "(no background processes started)";
        return [...bgProcs.entries()]
          .map(([id, e]) => `${id} pid=${e.pid} status=${!e.stopped && isAlive(e.pid) ? "running" : "exited"} command="${e.command}"`)
          .join("\n");
      }
      case "fetch_url": {
        let u;
        try {
          u = new URL(args.url);
        } catch {
          return `ERROR: not a valid URL: ${args.url}`;
        }
        if (!LOCAL_HOSTS.has(u.hostname)) {
          return `ERROR: fetch_url is restricted to localhost/127.0.0.1 for safety, got host "${u.hostname}".`;
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const res = await fetch(u, { signal: controller.signal });
          clearTimeout(timer);
          const body = await res.text();
          return `status: ${res.status}\n--- body (truncated) ---\n${body.slice(0, 4000)}`;
        } catch (err) {
          return `ERROR fetching ${args.url}: ${err.message}`;
        }
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  function cleanup() {
    for (const [, entry] of bgProcs) {
      if (entry.stopped || !isAlive(entry.pid)) continue;
      try {
        process.kill(-entry.pid, "SIGTERM");
      } catch {
        try {
          process.kill(entry.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
      entry.stopped = true;
    }
  }

  return { definitions, call, cleanup };
}
