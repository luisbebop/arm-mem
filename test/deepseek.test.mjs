import assert from "node:assert/strict";
import test from "node:test";
import { deepseek } from "../dist/index.js";

test("sends Flash/max settings and returns only final answer and usage", async () => {
  const usage = { prompt_tokens: 200, completion_tokens: 30 };
  const agent = deepseek({ apiKey: "test-only", fetch: async (url, request) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer test-only");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.max_tokens, 131072);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.deepEqual(JSON.parse(body.messages[1].content).memory, [
      { id: 4, content: "Cedar uses SQLite.", evidence: "User decision", author: "user" },
    ]);
    return Response.json({ usage, choices: [{ finish_reason: "stop", message: {
      content: "Cedar uses SQLite [4].", reasoning_content: "private scratchpad",
    } }] });
  } });
  const result = await agent("Cedar database?", [
    { id: 4, content: "Cedar uses SQLite.", evidence: "User decision", author: "user" },
  ]);
  assert.deepEqual(result, { answer: "Cedar uses SQLite [4].", usage });
  assert.ok(!JSON.stringify(result).includes("scratchpad"));
});

test("provider failures stay visible and are not retried or echoed", async () => {
  for (const status of [401, 402, 429, 500]) {
    let calls = 0;
    const agent = deepseek({ apiKey: "test-only", fetch: async () => {
      calls++;
      return new Response("sensitive provider response", { status });
    } });
    await assert.rejects(agent("Question", []), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes("sensitive"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("truncated, empty, malformed, and reasoning-only responses are rejected", async () => {
  for (const payload of [
    { choices: [{ finish_reason: "length", message: { content: "partial" } }] },
    { choices: [{ finish_reason: "stop", message: { content: " " } }] },
    { choices: [{ finish_reason: "stop", message: { reasoning_content: "internal" } }] },
    { choices: [] },
  ]) {
    const agent = deepseek({ apiKey: "test-only", fetch: async () => Response.json(payload) });
    await assert.rejects(agent("Question", []), /empty or incomplete/);
  }
});

test("missing credentials and invalid limits fail before any request", () => {
  assert.throws(() => deepseek({ apiKey: "" }), /DEEPSEEK_API_KEY/);
  assert.throws(() => deepseek({ apiKey: "test-only", maxTokens: 0 }), /maxTokens/);
  assert.throws(() => deepseek({ apiKey: "test-only", timeoutMs: 360000 }), /timeoutMs/);
});
