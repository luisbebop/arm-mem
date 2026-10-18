import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import type { Memory, Store } from "./store.js";

const encoder = new Tiktoken(o200k);
export const EVIDENCE_BUDGET = 8000;

/** Evidence accounting used in the BEAM evaluation. */
export function evidenceUnits(text: string): number {
  return Math.max(Math.ceil([...text].length / 4), encoder.encode(text, [], []).length);
}

export function recallContext(store: Store, query: string): { memories: Memory[]; units: number } {
  const memories: Memory[] = [];
  let units = 0;
  for (const memory of store.recall(query, 100)) {
    const cost = evidenceUnits(memory.content);
    if (units + cost > EVIDENCE_BUDGET) break;
    memories.push(memory);
    units += cost;
  }
  return { memories, units };
}
