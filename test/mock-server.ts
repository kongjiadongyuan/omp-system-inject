// Mock OpenAI-compatible endpoint. Captures every request body to $MOCK_CAPTURE (JSONL).
import { appendFileSync } from "node:fs";
const capture = process.env.MOCK_CAPTURE ?? "/tmp/mock-capture.jsonl";
const port = Number(process.env.MOCK_PORT ?? 0);
const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "mock-small" }, { id: "mock-big" }] });
    }
    const body = await req.json().catch(() => ({}));
    appendFileSync(capture, JSON.stringify({ path: url.pathname, body }) + "\n");
    const id = "chatcmpl-mock", model = body.model ?? "mock";
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    // Scripted tool call: parent asks to SPAWN_SUBAGENT and has no tool result yet -> call `task`.
    const msgs: any[] = body.messages ?? [];
    const text = (m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    const wantsSpawn = msgs.some(m => m.role === "user" && text(m).includes("SPAWN_SUBAGENT")) && !msgs.some(m => m.role === "tool");
    if (wantsSpawn && body.stream && (body.tools ?? []).some((t: any) => t.function?.name === "task")) {
      const args = JSON.stringify({ i: "Delegating", context: "ctx", tasks: [{ name: "Sub", task: "SUBTASK_PLEASE_REPLY", solutionSpace: "any" }] });
      const sse = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "task", arguments: args } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    // After the task tool result, call `wait` once so the parent blocks until the subagent finishes.
    const toolMsgs = msgs.filter(m => m.role === "tool");
    if (body.stream && toolMsgs.length === 1 && text(toolMsgs[0]).includes("Spawned agent") && (body.tools ?? []).some((t: any) => t.function?.name === "wait")) {
      const sse = chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "wait", arguments: JSON.stringify({ i: "Waiting" }) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    if (!body.stream) {
      return Response.json({ id, object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content: "MOCK_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const sse = chunk({ role: "assistant", content: "MOCK_OK" }) + chunk({}, "stop") +
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`MOCK_PORT=${server.port}`);
