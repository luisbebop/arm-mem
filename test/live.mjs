// Explicit opt-in: one paid Flash/max call against a temporary database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, deepseek, workOnce } from "../dist/index.js";

const agent = deepseek();
const directory = mkdtempSync(join(tmpdir(), "arm-mem-live-"));
const store = new Store(join(directory, "test.db"));
try {
  const id = store.remember("Project Cedar uses SQLite for durable memory.", "Synthetic user decision");
  store.enqueue("Which database does Project Cedar use? Answer in one sentence.");
  const result = await workOnce(store, agent, "live-check");
  assert.match(result.answer, /SQLite/i);
  assert.deepEqual(result.usedMemoryIds, [id]);
  assert.equal(store.tasks()[0].state, "done");
  assert.equal(store.memories().length, 1);
  console.log(JSON.stringify({ passed: true, answer: result.answer, usage: result.usage }, null, 2));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
