#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Store, deepseek, recallContext, workOnce } from "./index.js";

const help = `arm-mem — shared SQLite memory + DeepSeek Flash/max

  arm-mem init
  arm-mem remember "fact" "source"
  arm-mem ingest file.txt "source"
  arm-mem recall "query"
  arm-mem ask "question"          Answer now, without queuing
  arm-mem add "task" [priority]
  arm-mem work [worker-name]      Process one queued task, then exit
  arm-mem tasks | memories
  arm-mem accept | retire | retry ID
  arm-mem backup new-file.db

Environment: DEEPSEEK_API_KEY, ARM_MEM_DB (default: ./arm-mem.db)
`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") { console.log(help); return; }
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
      case "remember": result = { memory: store.remember(first, second) }; break;
      case "ingest": result = { memories: store.ingest(readFileSync(first, "utf8"), second) }; break;
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
