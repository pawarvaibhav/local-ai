import { chat } from "./ollama.mjs";
import { buildTools } from "./tools.mjs";

const SYSTEM = (cwd) => `You are a local coding agent running on the user's own machine via Ollama.
Your sandbox root is: ${cwd}
You have tools: read_file, write_file, list_dir, run_shell, finish. All file/shell operations are scoped to the sandbox root.

Your job for each task:
1. Explore the relevant files with list_dir/read_file before changing anything.
2. Make the required changes with write_file.
3. BUILD it and TEST it using run_shell (use the project's real build/test/lint commands). Fix failures and re-run until they pass.
4. Only call finish(success=true, report=...) once you have actually run build/tests and they passed. If you get stuck or the task is impossible, call finish(success=false, report=...) explaining why.

Be efficient: don't narrate excessively, just act via tools. Never assume something works without running it.`;

export async function runLocalAgent({ task, cwd, maxSteps = 25, maxMs = 10 * 60 * 1000 }) {
  const tools = buildTools(cwd);
  const messages = [
    { role: "system", content: SYSTEM(cwd) },
    { role: "user", content: task },
  ];
  const log = [];
  const start = Date.now();

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() - start > maxMs) {
      log.push("TIMEOUT: wall-clock budget exceeded, stopping.");
      return { success: false, report: "Stopped: exceeded time budget before finishing.", steps: step, log };
    }

    let res;
    try {
      res = await chat({ messages, tools: tools.definitions });
    } catch (err) {
      log.push(`ERROR calling local model: ${err.message}`);
      return { success: false, report: `Local model call failed: ${err.message}`, steps: step, log };
    }

    const msg = res.message ?? { role: "assistant", content: "" };
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      log.push(`[model] ${msg.content ?? ""}`);
      messages.push({
        role: "user",
        content: "Continue. Use a tool call to act, or call finish when done.",
      });
      continue;
    }

    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      const name = tc.function.name;
      let args = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const callId = tc.id || `${step}-${i}`;

      if (name === "finish") {
        log.push(`[finish] success=${args.success} report=${args.report}`);
        return { success: !!args.success, report: args.report ?? "", steps: step + 1, log };
      }

      let result;
      try {
        result = await tools.call(name, args || {});
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      const resultStr = String(result);
      log.push(`[tool] ${name}(${JSON.stringify(args)}) -> ${resultStr.slice(0, 2000)}`);
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: resultStr.slice(0, 8000),
      });
    }
  }

  return { success: false, report: "Stopped: exceeded step budget without calling finish.", steps: maxSteps, log };
}
