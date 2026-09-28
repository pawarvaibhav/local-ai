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

Be efficient: don't narrate excessively, just act via tools. Never assume something works without running it.

Rules for git/publish-style tasks:
- Before any mutating command (commit, push, tag, publish), run a read-only
  command first (git status / git diff) so you know exactly what you're
  about to change.
- After any mutating command, verify it actually happened with a read-only
  follow-up (e.g. git log -1, git status) and check that output before
  calling finish(success=true). A command producing no error is not proof
  it worked — confirm the state actually changed.
- Write commit messages that describe only what is actually in the diff.
  Never invent features, files, or behavior that aren't really there.
- Never use force flags of any kind (--force, --force-with-lease, -f,
  git reset --hard, git clean -f, git branch -D, etc.), even if a step
  seems stuck. If a run_shell result starts with "BLOCKED:", that command
  is permanently disallowed — do not retry it or a variant of it. Stop and
  call finish(success=false, report=...) explaining what was blocked and
  why you couldn't proceed without it.`;

export async function runLocalAgent({ task, cwd, maxSteps = 25, maxMs = 10 * 60 * 1000 }) {
  const tools = buildTools(cwd);
  const messages = [
    { role: "system", content: SYSTEM(cwd) },
    { role: "user", content: task },
  ];
  const log = [];
  const start = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() - start > maxMs) {
      log.push("TIMEOUT: wall-clock budget exceeded, stopping.");
      return { success: false, report: "Stopped: exceeded time budget before finishing.", steps: step, log, promptTokens, completionTokens };
    }

    let res;
    try {
      res = await chat({ messages, tools: tools.definitions });
    } catch (err) {
      log.push(`ERROR calling local model: ${err.message}`);
      return { success: false, report: `Local model call failed: ${err.message}`, steps: step, log, promptTokens, completionTokens };
    }
    promptTokens += res.prompt_eval_count ?? 0;
    completionTokens += res.eval_count ?? 0;

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
        return { success: !!args.success, report: args.report ?? "", steps: step + 1, log, promptTokens, completionTokens };
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

  return { success: false, report: "Stopped: exceeded step budget without calling finish.", steps: maxSteps, log, promptTokens, completionTokens };
}
