import { randomUUID } from "node:crypto";
import { recallContext } from "./context.js";
import type { Agent } from "./deepseek.js";
import type { Store } from "./store.js";

/** Claim one task, release the database lock, call the agent, then commit. */
export async function workOnce(store: Store, agent: Agent, worker = `worker-${randomUUID()}`) {
  const task = store.claim(worker);
  if (!task) return undefined;
  try {
    const context = recallContext(store, task.prompt);
    const result = await agent(task.prompt, context.memories);
    const usedMemoryIds = context.memories.map(memory => memory.id);
    store.finish(task, result, usedMemoryIds);
    return { taskId: task.id, worker, ...result, usedMemoryIds };
  } catch (error) {
    store.fail(task, error);
    throw error;
  }
}
