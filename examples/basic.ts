import { Store, deepseek, workOnce } from "../dist/index.js";

const store = new Store(process.env.ARM_MEM_DB ?? "arm-mem.db");
try {
  const agent = deepseek();
  store.remember("Project Cedar uses SQLite for durable memory.", "User's project decision");
  store.enqueue("What database does Cedar use, and why?");
  const result = await workOnce(store, agent, "example-worker");
  console.log(result?.answer);
} finally {
  store.close();
}
