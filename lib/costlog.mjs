import { promises as fs } from "node:fs";
import path from "node:path";

// Pricing for the Claude model this offload replaces (Sonnet 5, the model
// Claude Code sessions run on when they delegate here). $/1M tokens.
const CLAUDE_INPUT_PER_MTOK = 2.0;
const CLAUDE_OUTPUT_PER_MTOK = 10.0;

export const LOG_PATH = path.join(import.meta.dirname, "..", "savings.jsonl");

export function estimateCostUSD(promptTokens = 0, completionTokens = 0) {
  return (promptTokens / 1e6) * CLAUDE_INPUT_PER_MTOK + (completionTokens / 1e6) * CLAUDE_OUTPUT_PER_MTOK;
}

// Rough category for what kind of work a task represents, so the savings
// log is groupable without needing the model to self-report.
export function categorize(tool, text = "") {
  const t = text.toLowerCase();
  if (tool === "ask_local") return "qa-research";
  if (tool === "summarize_file") return "file-summarization";
  if (tool === "search_explain") return "code-search";
  if (tool === "local_agent_run") {
    if (/\bdocker\b/.test(t)) return "docker-operation";
    if (/\bgit\b|\bcommit\b|\bpush\b|\bpull request\b|\bpr\b|\bmerge\b/.test(t)) return "git-operation";
    if (/\btest(s|ing)?\b/.test(t)) return "testing";
    if (/\bdocs?\b|\breadme\b/.test(t)) return "docs";
    if (/\brefactor\b/.test(t)) return "refactor";
    return "coding-task";
  }
  return "other";
}

export async function readEntries() {
  let raw;
  try {
    raw = await fs.readFile(LOG_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function summarize() {
  const entries = await readEntries();
  const byCategory = {};
  let totalCostUSD = 0;
  let totalCalls = 0;
  let firstTs = null;
  let lastTs = null;

  for (const e of entries) {
    totalCalls += 1;
    totalCostUSD += e.estimatedClaudeCostUSD ?? 0;
    const cat = e.category || "other";
    byCategory[cat] = byCategory[cat] || { calls: 0, costUSD: 0 };
    byCategory[cat].calls += 1;
    byCategory[cat].costUSD += e.estimatedClaudeCostUSD ?? 0;
    if (!firstTs || e.ts < firstTs) firstTs = e.ts;
    if (!lastTs || e.ts > lastTs) lastTs = e.ts;
  }

  return {
    totalCalls,
    totalCostUSD,
    byCategory,
    firstTs,
    lastTs,
    entries,
  };
}

export async function logSavings({ tool, category, detail, promptTokens = 0, completionTokens = 0, steps }) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    category,
    detail: (detail || "").replace(/\s+/g, " ").trim().slice(0, 140),
    promptTokens,
    completionTokens,
    steps,
    estimatedClaudeCostUSD: Number(estimateCostUSD(promptTokens, completionTokens).toFixed(6)),
  };
  await fs.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}
