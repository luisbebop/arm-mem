import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Store, LostClaim, evidenceUnits, recallContext, workOnce } from "../dist/index.js";

const moduleURL = new URL("../dist/index.js", import.meta.url).href;
function fixture(t, now) {
  const directory = mkdtempSync(join(tmpdir(), "arm-mem-test-"));
  const path = join(directory, "memory.db");
  const store = new Store(path, now);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory, path };
}
function child(code) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code]);
    let output = "", error = "";
    process.stdout.on("data", chunk => { output += chunk; });
    process.stderr.on("data", chunk => { error += chunk; });
    process.on("error", reject);
    process.on("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
}

test("a new process inherits identity and only reviewed agent memories", async t => {
  const { store, path } = fixture(t);
  store.enqueue("Record the Cedar database decision");
  await workOnce(store, async () => ({ answer: "Noted", memories: [
    { content: "Cedar uses SQLite.", evidence: "User project decision" },
  ] }), "writer");
  const memory = store.memories()[0];
  assert.equal(memory.status, "proposed");
  assert.equal(memory.source_task, 1);
  assert.deepEqual(store.recall("Cedar"), []);
  store.review(memory.id, "accepted");
  store.enqueue("What database does Cedar use?");
  const result = await child(`
    import { Store, workOnce } from ${JSON.stringify(moduleURL)};
    const store = new Store(${JSON.stringify(path)});
    const result = await workOnce(store, async (_, memories) => ({ answer: memories[0].content }), "reader");
    console.log(JSON.stringify({ identity: store.identity, result }));
    store.close();
  `);
  assert.equal(result.identity, store.identity);
  assert.equal(result.result.answer, "Cedar uses SQLite.");
  assert.deepEqual(JSON.parse(store.tasks()[1].result).used_memory_ids, [memory.id]);
});

test("independent worker processes claim each queued task exactly once", async t => {
  const { store, path } = fixture(t);
  for (let i = 0; i < 12; i++) store.enqueue(`Task ${i}`, i === 11 ? 10 : 0);
  const first = store.claim("priority-check");
  assert.equal(first.id, 12);
  store.finish(first, { answer: "Priority first" }, []);
  const batches = await Promise.all(Array.from({ length: 4 }, (_, index) => child(`
    import { Store, workOnce } from ${JSON.stringify(moduleURL)};
    const store = new Store(${JSON.stringify(path)}), ids = [];
    for (;;) {
      const result = await workOnce(store, async prompt => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { answer: prompt };
      }, "worker-${index}");
      if (!result) break;
      ids.push(result.taskId);
    }
    console.log(JSON.stringify(ids));
    store.close();
  `)));
  assert.deepEqual(batches.flat().sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i + 1));
  assert.ok(store.tasks().every(task => task.state === "done" && task.attempts === 1));
});

test("expired claims cannot commit or overwrite a replacement worker", t => {
  let now = 100;
  const { store } = fixture(t, () => now);
  store.enqueue("Cedar decision");
  const old = store.claim("old", 10);
  now = 105;
  assert.equal(store.claim("early"), undefined);
  now = 111;
  assert.throws(() => store.finish(old, { answer: "Too late" }, []), LostClaim);
  const replacement = store.claim("replacement");
  assert.equal(replacement.id, old.id);
  assert.throws(() => store.finish(old, { answer: "Stale", memories: [
    { content: "Stale fact", evidence: "old worker" },
  ] }, []), LostClaim);
  store.fail(old, new Error("stale failure"));
  store.finish(replacement, { answer: "Current" }, []);
  assert.deepEqual(store.memories(), []);
  assert.equal(JSON.parse(store.tasks()[0].result).answer, "Current");
});

test("three expired attempts stop recovery until explicitly retried", t => {
  let now = 100;
  const { store } = fixture(t, () => now);
  const id = store.enqueue("Crash repeatedly");
  for (let i = 0; i < 3; i++) {
    assert.equal(store.claim("crashing", 1).attempts, i + 1);
    now += 2;
  }
  assert.equal(store.claim("fourth"), undefined);
  assert.equal(store.tasks()[0].state, "failed");
  store.retry(id);
  assert.equal(store.claim("replacement").attempts, 1);
  assert.throws(() => store.retry(id), /failed task/);
});

test("a malformed proposal rolls back the answer and all proposed memories", async t => {
  const { store } = fixture(t);
  store.enqueue("Write two memories");
  await assert.rejects(workOnce(store, async () => ({ answer: "Done", memories: [
    { content: "Cedar uses SQLite.", evidence: "User" },
    { content: "Missing evidence" },
  ] })), /evidence/);
  assert.deepEqual(store.memories(), []);
  assert.equal(store.tasks()[0].state, "failed");
  assert.equal(store.tasks()[0].result, null);
});

test("duplicate facts keep provenance and do not revive retired memories", t => {
  const { store } = fixture(t);
  const old = store.remember("Cedar uses Postgres.", "Old decision");
  store.review(old, "retired");
  assert.equal(store.remember("Cedar uses Postgres.", "Repeated claim"), old);
  const current = store.remember("Cedar uses SQLite.", "New decision");
  assert.deepEqual(store.recall('Cedar OR NOT " - *').map(m => m.id), [current]);
  assert.deepEqual(store.recall('" - *'), []);
  assert.equal(store.memories()[0].evidence, "Old decision");
  assert.equal(store.memories()[0].status, "retired");
});

test("long Unicode sources are chunked without losing content or splitting code points", t => {
  const { store } = fixture(t);
  const chars = [...Array.from({ length: 1000 }, (_, i) => `🌱${i}猫`).join("")].slice(0, 3600);
  const ids = store.ingest(chars.join(""), "Archive");
  assert.equal(ids.length, 3);
  const chunks = store.memories().map(m => [...m.content]);
  assert.deepEqual(chunks[0], chars.slice(0, 1800));
  assert.deepEqual(chunks[1], chars.slice(1600, 3400));
  assert.deepEqual(chunks[2], chars.slice(3200));
  assert.throws(() => store.remember("🌱".repeat(2001), "Archive"), /2000/);
  assert.throws(() => store.ingest("new source".repeat(400), ""), /evidence/);
  assert.equal(store.memories().length, 3);
});

test("backup includes committed WAL state and refuses existing destinations", async t => {
  const { store, directory, path } = fixture(t);
  store.remember("Cedar uses SQLite.", "User decision");
  const destination = join(directory, "backup.db");
  await store.backup(destination);
  const restored = new Store(destination);
  try {
    assert.equal(restored.identity, store.identity);
    assert.equal(restored.recall("Cedar")[0].content, "Cedar uses SQLite.");
  } finally { restored.close(); }
  await assert.rejects(store.backup(destination), /EEXIST/);
  await assert.rejects(store.backup(path), /EEXIST/);
});

test("retrieval and context packing match the frozen Python oracle", t => {
  const { store } = fixture(t);
  const oracle = JSON.parse(readFileSync(new URL("./fixtures/python-reference.json", import.meta.url), "utf8"));
  for (const memory of oracle.memories) {
    const id = store.remember(memory.content, memory.evidence);
    if (memory.status !== "accepted") store.review(id, memory.status);
  }
  for (const item of oracle.queries) {
    assert.deepEqual(store.recall(item.query).map(m => m.id), item.ranked_ids, item.query);
    const context = recallContext(store, item.query);
    assert.deepEqual(context.memories.map(m => m.id), item.context_ids, item.query);
    assert.equal(context.units, item.units, item.query);
  }
  for (const item of oracle.token_counts) assert.equal(evidenceUnits(item.text), item.units, item.text);
});

test("CLI can recall without an API key", async t => {
  const { store, path } = fixture(t);
  store.remember("Cedar uses SQLite.", "User decision");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const output = await new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [cli, "recall", "Cedar"], {
      env: { ...globalThis.process.env, ARM_MEM_DB: path, DEEPSEEK_API_KEY: "" },
    });
    let text = "";
    process.stdout.on("data", chunk => { text += chunk; });
    process.on("error", reject);
    process.on("close", code => code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`exit ${code}`)));
  });
  assert.equal(output.memories[0].content, "Cedar uses SQLite.");
});
