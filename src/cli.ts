#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Store, deepseek, recallContext, workOnce } from "./index.js";
import type { MemoryKind, MemoryOptions, RetentionPolicy } from "./index.js";

const help = `arm-mem — shared SQLite memory + DeepSeek Flash/max

  arm-mem init
  arm-mem remember "fact" "source" [--kind decision --importance 0.9]
  arm-mem ingest file.txt "source" [--kind semantic]
  arm-mem recall "query"
  arm-mem ask "question"          Answer now, without queuing
  arm-mem add "task" [priority]
  arm-mem work [worker-name]      Process one queued task, then exit
  arm-mem tasks | memories
  arm-mem accept | retire | retry ID
  arm-mem backup new-file.db

Memory options for remember/ingest: --author, --kind, --importance, --confidence,
  --retention, --expires-at. Kinds: semantic, episodic, procedural, preference,
  decision, observation, consolidated. Retention: permanent, stable, temporary, session.

Environment: DEEPSEEK_API_KEY, ARM_MEM_DB (default: ./arm-mem.db)
`;

function needValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseMemoryArgs(raw: string[]): { args: string[]; options: MemoryOptions } {
  const args: string[] = [];
  const options: MemoryOptions = {};
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!;
    switch (arg) {
      case "--author": options.author = needValue(arg, raw[++i]); break;
      case "--kind": options.kind = needValue(arg, raw[++i]) as MemoryKind; break;
      case "--importance": options.importance = Number(needValue(arg, raw[++i])); break;
      case "--confidence": options.confidence = Number(needValue(arg, raw[++i])); break;
      case "--retention": options.retention = needValue(arg, raw[++i]) as RetentionPolicy; break;
      case "--expires-at": {
        const value = needValue(arg, raw[++i]);
        options.expiresAt = value === "null" || value === "none" ? null : Number(value);
        break;
      }
      default: args.push(arg);
    }
  }
  return { args, options };
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") { console.log(help); return; }
  const parsed = command === "remember" || command === "ingest"
    ? parseMemoryArgs(rawArgs)
    : { args: rawArgs, options: undefined };
  const args = parsed.args;
  const arity: Record<string, [number, number]> = {
    init: [0, 0], remember: [2, 2], ingest: [2, 2], recall: [1, 1], ask: [1, 1],
    add: [1, 2], work: [0, 1], tasks: [0, 0], memories: [0, 0],
    accept: [1, 1], retire: [1, 1], retry: [1, 1], backup: [1, 1],
  };
  const range = arity[command];
  if (!range || args.length < range[0] || args.length > range[1]) throw new Error(help);
  const first = args[0]!;
  const second = args[1]!;
  const store = new Store(process.env.ARM_MEM_DB ?? "arm-mem.db");
  try {
    let result: unknown;
    switch (command) {
      case "init": result = { identity: store.identity }; break;
      case "remember": result = { memory: store.remember(first, second, parsed.options) }; break;
      case "ingest": result = { memories: store.ingest(readFileSync(first, "utf8"), second, parsed.options) }; break;
      case "recall": result = recallContext(store, first); break;
      case "ask": {
        const context = recallContext(store, first);
        result = { ...await deepseek()(first, context.memories), usedMemoryIds: context.memories.map(m => m.id) };
        break;
      }
      case "add": result = { task: store.enqueue(first, second === undefined ? 0 : Number(second)) }; break;
      case "work": result = await workOnce(store, deepseek(), args[0]) ?? { status: "idle" }; break;
      case "tasks": result = store.tasks(); break;
      case "memories": result = store.memories(); break;
      case "accept": case "retire": case "retry": {
        const id = Number(first);
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("ID must be a positive integer.");
        if (command === "retry") store.retry(id);
        else store.review(id, command === "accept" ? "accepted" : "retired");
        result = { id, action: command };
        break;
      }
      case "backup": await store.backup(first); result = { backup: first }; break;
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
