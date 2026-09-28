#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { complete, MODEL } from "./lib/ollama.mjs";
import { runLocalAgent } from "./lib/agent.mjs";

const execFileAsync = promisify(execFile);

const [, , cmd, ...rest] = process.argv;

function usage() {
  console.log(`local-ai <command> [args]

Commands:
  ask "<prompt>"                     Ask the local model a question.
  summarize <file> ["<question>"]    Summarize/digest a file locally.
  search "<pattern>" [dir] ["<q>"]   ripgrep + local model explains the matches.
  agent "<task>" [cwd]               Autonomous local coding agent (build/test/validate loop).
  status                             Check Ollama + model reachability.

Model: ${MODEL} (override with LOCAL_AI_MODEL env var)
`);
}

async function main() {
  switch (cmd) {
    case "ask": {
      const prompt = rest.join(" ");
      if (!prompt) return usage();
      console.log(await complete(prompt));
      break;
    }
    case "summarize": {
      const [file, ...q] = rest;
      if (!file) return usage();
      const content = await fs.readFile(path.resolve(file), "utf8");
      const question = q.join(" ");
      const prompt = question
        ? `Here is the content of ${file}:\n\n${content}\n\n---\nAnswer: ${question}`
        : `Summarize this file concisely:\n\n${content}`;
      console.log(await complete(prompt, { system: "You are a careful code/document summarizer." }));
      break;
    }
    case "search": {
      const [pattern, dir, ...q] = rest;
      if (!pattern) return usage();
      const searchDir = path.resolve(dir || ".");
      let matches;
      try {
        const { stdout } = await execFileAsync("rg", ["-n", "--max-count=5", "-C", "1", pattern, searchDir], {
          maxBuffer: 5 * 1024 * 1024,
        });
        matches = stdout;
      } catch (err) {
        matches = err.stdout || "";
      }
      if (!matches.trim()) {
        console.log(`No matches for "${pattern}" in ${searchDir}.`);
        break;
      }
      const question = q.join(" ") || "Summarize where/how this is used and anything notable.";
      console.log(
        await complete(`ripgrep matches for "${pattern}" in ${searchDir}:\n\n${matches.slice(0, 20000)}\n\n---\n${question}`, {
          system: "You are a careful code analyst. Reference file:line when relevant.",
        })
      );
      break;
    }
    case "agent": {
      const [task, cwd] = rest;
      if (!task) return usage();
      const dir = path.resolve(cwd || ".");
      console.log(`Running local agent in ${dir} ...\n`);
      const result = await runLocalAgent({ task, cwd: dir });
      console.log(`\nsuccess: ${result.success}\nsteps: ${result.steps}\nreport: ${result.report}\n`);
      console.log(`--- trace ---\n${result.log.join("\n")}`);
      break;
    }
    case "status": {
      try {
        const res = await fetch(`${process.env.OLLAMA_HOST || "http://localhost:11434"}/api/version`);
        const v = await res.json();
        console.log(`Ollama version ${v.version}, model=${MODEL}`);
      } catch (err) {
        console.log(`Ollama unreachable: ${err.message}`);
      }
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
