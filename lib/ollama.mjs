const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
export const MODEL = process.env.LOCAL_AI_MODEL || "qwen3-coder:30b";

export async function chat({ messages, tools, temperature = 0.2 }) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      options: { temperature },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function complete(prompt, { system, temperature = 0.2 } = {}) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await chat({ messages, temperature });
  return {
    text: res.message?.content ?? "",
    promptTokens: res.prompt_eval_count ?? 0,
    completionTokens: res.eval_count ?? 0,
  };
}
