#!/usr/bin/env node
// Regenerates docs/index.html from savings.jsonl. Run before each commit so
// GitHub Pages (serving /docs on main) reflects the latest numbers.
import { promises as fs } from "node:fs";
import path from "node:path";
import { summarize } from "../lib/costlog.mjs";

const OUT_DIR = path.join(import.meta.dirname, "..", "docs");
const OUT_FILE = path.join(OUT_DIR, "index.html");

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtUSD(n) {
  return `$${n.toFixed(4)}`;
}

async function main() {
  const s = await summarize();
  const maxCost = Math.max(1e-9, ...Object.values(s.byCategory).map((v) => v.costUSD));
  const rows = Object.entries(s.byCategory)
    .sort((a, b) => b[1].costUSD - a[1].costUSD)
    .map(([cat, v]) => {
      const pct = (v.costUSD / maxCost) * 100;
      return `<tr>
        <td class="cat">${esc(cat)}</td>
        <td class="num">${v.calls}</td>
        <td class="num">${fmtUSD(v.costUSD)}</td>
        <td class="bar-cell"><div class="bar" style="width:${pct.toFixed(1)}%"></div></td>
      </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>local-ai savings</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --accent: #2563eb;
    --border: #e5e7eb; --bar-bg: #eef2ff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0f19; --fg: #e5e7eb; --muted: #9ca3af; --accent: #60a5fa; --border: #1f2937; --bar-bg: #1e293b; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px; background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  nav { margin-bottom: 20px; font-size: 0.85rem; }
  nav a { color: var(--muted); text-decoration: none; margin-right: 16px; }
  nav a.active { color: var(--fg); font-weight: 600; }
  nav a:hover { color: var(--accent); }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 28px; }
  .stats { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  .stat { flex: 1; min-width: 160px; border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .stat .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-size: 1.6rem; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 0.8rem; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  td.cat { text-transform: capitalize; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bar-cell { width: 40%; }
  .bar { height: 8px; background: var(--accent); border-radius: 4px; background: linear-gradient(90deg, var(--accent), var(--accent)); }
  .bar-cell { background: var(--bar-bg); border-radius: 4px; }
  footer { margin-top: 28px; color: var(--muted); font-size: 0.78rem; }
</style>
</head>
<body>
<main>
  <nav>
    <a href="index.html" class="active">Savings</a>
    <a href="capabilities.html">Capabilities</a>
  </nav>

  <h1>local-ai savings</h1>
  <p class="sub">Work delegated from Claude Code to the local Ollama model, and the Claude usage it avoided.</p>

  <div class="stats">
    <div class="stat">
      <div class="label">Local calls</div>
      <div class="value">${s.totalCalls}</div>
    </div>
    <div class="stat">
      <div class="label">Est. Claude cost saved</div>
      <div class="value">${fmtUSD(s.totalCostUSD)}</div>
    </div>
    <div class="stat">
      <div class="label">Since</div>
      <div class="value" style="font-size:1rem;">${s.firstTs ? esc(s.firstTs.slice(0, 10)) : "—"}</div>
    </div>
  </div>

  <table>
    <thead><tr><th>Category</th><th style="text-align:right">Calls</th><th style="text-align:right">Est. cost saved</th><th></th></tr></thead>
    <tbody>
      ${rows || `<tr><td colspan="4" style="color:var(--muted)">No logged work yet.</td></tr>`}
    </tbody>
  </table>

  <footer>Estimated against Claude Sonnet 5 pricing ($2/$10 per MTok in/out) using local token counts as a proxy — approximate, not a billing record. Generated ${esc(new Date().toISOString())}.</footer>
</main>
</body>
</html>
`;

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, html, "utf8");
  await fs.writeFile(path.join(OUT_DIR, ".nojekyll"), "", "utf8");
  console.log(`Wrote ${OUT_FILE} (${s.totalCalls} entries, ${fmtUSD(s.totalCostUSD)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
