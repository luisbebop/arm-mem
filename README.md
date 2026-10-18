# arm-mem

**Memory that outlives agents.**

Small TypeScript workers share durable memory and a task queue in SQLite.
DeepSeek Flash answers with maximum reasoning. Workers come and go; their shared
history stays. One runtime dependency for token counting, no database server or
agent framework.

[Start](#start) · [Use in your app](#use-in-your-app) ·
[Origin and philosophy](#origin-and-philosophy) · [Tested result](#tested-result)

## Start

Requires **Node.js 22.18+**. Answering tasks also requires your own DeepSeek API key.

```sh
git clone https://github.com/luisbebop/arm-mem.git
cd arm-mem
npm ci
npm run build
cp .env.example .env
# Add your DEEPSEEK_API_KEY to .env.

npm run cli -- remember "Cedar uses SQLite." "User's project decision"
npm run cli -- ask "What database does Cedar use?"
```

Memory stays in `arm-mem.db`. Set `ARM_MEM_DB` to use another file. Add longer
source text with `npm run cli -- ingest notes.txt "source"`. Storage and retrieval
work without an API key:

```sh
npm run cli -- recall "Cedar database"
```

## Use in your app

Install the [release package](https://github.com/luisbebop/arm-mem/releases/tag/v0.1.0):

```sh
npm install https://github.com/luisbebop/arm-mem/releases/download/v0.1.0/arm-mem-0.1.0.tgz
```

Then set `DEEPSEEK_API_KEY` in your app's environment:

```ts
import { Store, deepseek, recallContext } from "arm-mem";

const store = new Store("team.db");
try {
  store.remember("Cedar uses SQLite.", "User's project decision");
  const question = "What database does Cedar use?";
  const { memories } = recallContext(store, question);
  const result = await deepseek()(question, memories);
  console.log(result.answer);
} finally {
  store.close();
}
```

The installed CLI is available as `npx --no-install arm-mem --help`.

## Run workers

```sh
npm run cli -- add "Explain Cedar's database choice."
npm run cli -- add "Summarize what we know about Cedar."
npm run cli -- work worker-a
# Another terminal can run another worker, sharing the same ARM_MEM_DB:
npm run cli -- work worker-b
npm run cli -- tasks
```

Each invocation claims one task and exits. Higher-priority tasks go first; pass a
priority number after the task text. New workers can recover expired claims.
Use `retry ID` for failed tasks and `backup new.db` for a consistent backup.
Workers share a local file on **one machine**. Use separate databases for
independent users or projects.

```text
                    shared SQLite database
                   /                      \
             task queue                sourced memory
                   \                      /
                     replaceable workers
               claim → recall → answer → save → exit
```

`work` saves the answer in task history. `ask` answers immediately without queuing
or saving the answer. Neither automatically turns an answer into accepted memory.

## What the memory does

`remember` stores a short statement with its source; `ingest` stores longer text
in overlapping chunks. Both explicitly accept the supplied material for retrieval.
Acceptance means eligible to use, not independently verified as true.

Search uses **SQLite FTS5/BM25** ranking: up to 100 accepted
records, packed into an 8,000-unit evidence budget. Each record costs the larger
of its token count or character count divided by four, rounded up. This allowance
covers memory text; the whole API request also includes instructions and metadata.
Retrieval makes no model calls and can miss synonyms that do not share words.

Conflicting claims stay separate, with their sources attached. The reader prompt
asks the model to describe disagreements and cite memory IDs. This gives the
model evidence to reason about; it does not guarantee correct conflict resolution.
Use `retire ID` to exclude an obsolete entry from future recall while keeping its
record available for inspection, then `remember` the correction with its source.

Custom agents can return up to three memory proposals alongside their answer.
Those remain excluded from recall until reviewed with `accept ID`. The built-in
DeepSeek adapter returns an answer and usage only. Extending memory is an explicit
step, so a fluent answer does not become shared knowledge merely by being generated.

## Origin and philosophy

arm-mem began with a conversation about **Armillaria**, the humongous fungus:
could agents preserve useful experience the way a living network persists through
the replacement of its parts? The conversation then turned to people. We inherit
language, tools, scientific knowledge, and institutions from people we never met.
Individual lives end while later generations continue some of their work.

Those two forms of continuity suggested a small architecture: a durable shared
store, temporary workers, and a way for useful records to reach future tasks.
arm-mem expresses that idea in TypeScript, with full-text retrieval and a
Flash/max reader.
The name **arm-mem** joins Armillaria and memory.

The ambition is to let work accumulate across sessions, processes, and eventually
generations of tools. The sections below distinguish the biological mechanisms,
the philosophical interpretation, and what this implementation actually provides.

### Armillaria: continuity through growth and replacement

The famous Oregon *Armillaria ostoyae* genet was mapped at approximately
965 hectares, or 2,385 acres. Researchers estimated its age at **1,900–8,650 years**
using different assumed rates of spread. These are estimates from size and growth,
rather than a directly observed lifespan. Its scale motivated this project; its
age does not establish that a similar software architecture will last as long.
[Ferguson et al., 2003](https://research.fs.usda.gov/treesearch/20135).

Rhizomorphs are organized strands of fungal hyphae. They extend through soil and
connect feeding sites, supporting transport within the network. Field research
on *Armillaria lutea* found interconnected routes that could preserve connections
after some links were severed, alongside critical links whose loss would separate
larger sections. Resilience depends on the actual structure and available resources.
[Lamour et al., 2007](https://academic.oup.com/femsec/article/62/2/222/435941).

For arm-mem, this becomes a set of engineering choices:

| Inspiration | Smallest implementation here |
| --- | --- |
| Continuity as parts are replaced | Database identity, stored memory, and task history survive worker restarts |
| Connections that carry resources | Transactions let workers exchange durable records through one store |
| Activity follows demand | Workers claim queued tasks in priority order |
| Waiting between opportunities | Workers exit; storage persists without idle model calls |
| Recovery after local loss | A later worker can reclaim an expired task |

These are analogies, not simulations of fungal physiology. SQLite centralizes
coordination; it does not reproduce a fungal network's physical redundancy.
Storage still needs maintenance and backups. The current system recovers from
worker loss, while loss of its only database can destroy its history.

### Genetics: what is inherited, and what is remembered

A **genet** is a genetic individual descended through clonal growth from an
originating reproductive event. In the Armillaria lifecycle described by Anderson
and colleagues, compatible haploid cells mate to establish diploid mycelium.
Rhizomorphs extend that lineage through vegetative growth and mitotic division;
each new strand does not require another mating. Rhizomorphs can also persist in
stasis until suitable substrates become available.
[Anderson et al., 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC6304041/).

Clonal continuity allows mutations. That study found remarkable genome stability,
but also somatic differences, in a roughly 2,500-year-old *A. gallica* individual
in **Michigan**, separate from Oregon's fungus. Relatively inactive cells at
growing tips were one proposed explanation among several; the protective mechanism
was not established. “Same genet” does not mean every nucleotide stays identical
in every cell forever.
[Anderson et al., 2018](https://pmc.ncbi.nlm.nih.gov/articles/PMC6304041/).

Genetic identity and physical connection are also distinct. A genet can become
fragmented while its surviving portions retain their clonal ancestry. Identifying
one genet across a landscape does not prove every sampled part still exchanges
resources with every other part.
[Bendel et al., 2006](https://doi.org/10.1016/j.mycres.2006.02.002).

The body's organization carries another kind of continuity. Existing routes and
colonized substrates shape what the fungus can reach next. In this analogy,
“memory” includes persistent material structure and physiological state; it does
not imply an archive of learned facts encoded in DNA. The network research
describes this structure and its role in resource movement.
[Lamour et al., 2007](https://academic.oup.com/femsec/article/62/2/222/435941).

The software analogy needs several layers. A model's weights and the program's
code provide capabilities and behavior. Stored records preserve particular
experiences. Retrieved context makes a small selection of those records available
for the current task. These layers play different roles:

| Layer | In arm-mem |
| --- | --- |
| Inherited machinery | The worker code, model, and common data format |
| Accumulated history | Sourced memories and saved task results |
| Working context | Records retrieved for one model call |
| Continuity | A persistent database UUID together with its retained state |

Calling weights a “genome” can help introduce the idea, but weights themselves
are products of training, and this package does not modify them. Writing a new
memory changes what a future agent can read. It does not genetically alter an
agent or teach every future model the fact internally. A replacement model can
use the same records if its adapter follows the interface; identical weights are
unnecessary for that continuity.

### Superorganisms and collective agency

Biologists use **superorganism** to discuss highly integrated societies, especially
social insects, where division of labor and coordination allow a colony to function
as a larger unit. Coordinating the parts is a separate problem from giving them
different roles. A large fungal genet is already one clonal organism; a colony of
distinct animals provides a different biological model for collective organization.
[Johnson and Linksvayer, 2010](https://pubmed.ncbi.nlm.nih.gov/20337260/).

For an agent system, the useful question is what makes separate runs participate
in one continuing project. Shared records supply continuity, the queue allocates
work, and common rules determine which contributions become reusable memory.
Workers coordinate by changing shared state. One can leave a result or an accepted
record that another encounters much later, without both being active together.

That makes collective agency a design possibility rather than a property conferred
by the word “swarm.” Several workers can also repeat mistakes, compete for irrelevant
tasks, or amplify a bad record. More processes do not automatically create more
intelligence. A useful collective needs a purpose, reliable evidence, correction,
and a way to judge whether cooperation actually improves outcomes.

arm-mem supplies a small substrate for that experiment. It has no autonomous task
decomposition, negotiated goals, specialist routing, or distributed consensus.
Claims about a conscious group mind go beyond both the implementation and the
evidence. Here, “superorganism” names an architectural inspiration: a continuing
whole whose useful state can outlast its current participants.

### Humans: culture carries what DNA does not

The human comparison changes the emphasis. People share much of their biology,
but civilization's accumulated mathematics, engineering decisions, and histories
are transmitted through teaching, language, artifacts, and institutions. A child
does not inherit knowledge of a bridge design through DNA. They can inherit
access to a culture that recorded how to build it.

Agents sharing a database are closer to this form of cultural inheritance. A new
worker can consult a decision made by an earlier one without having participated
in the original task. The durable record takes the role of a notebook or archive;
the retrieval step takes the role of finding the relevant passage. Access remains
selective: no worker automatically receives everything the system has ever stored.

This also explains why provenance matters. A civilization benefits from records
that distinguish observation, interpretation, disagreement, and correction.
Likewise, “Cedar uses SQLite” becomes more useful when its source and context are
preserved. Keeping two conflicting statements lets a future worker examine the
disagreement instead of inheriting an unexplained summary that hid one side.

Continuity is therefore more than accumulation. Forgotten sources, poor retrieval,
and repeated falsehoods can make a larger archive less useful. For this project,
learning at the system level means that retained, corrected information helps a
later task. That is an outcome to measure.

### The transhuman aspect: extending the reach of thought

The transhumanist connection is the possibility of extending human capabilities
through technology, including memory and intellectual work. Bostrom's account
includes both technical enhancement and the institutions that make capabilities
available. This project takes a modest part of that ambition: help a person's or
team's work persist beyond the limits of a single session and unaided recall.
[Bostrom, *Transhumanist Values*](https://nickbostrom.com/papers/transhumanist-values/).

Clark and Chalmers's **extended mind** thesis offers another lens. They argue that
reliably integrated external resources can participate in cognition, using a
notebook as a central example. It is a philosophical argument about how to draw
the boundary of a cognitive system, rather than proof that any external database
is a mind.
[Clark and Chalmers, 1998](https://www.consc.net/papers/extended.html).

Our interpretation is practical: a person, their records, and agents that help
retrieve and use those records can form a continuing workflow. Research from one
month can inform decisions the next. A collaborator can inherit the reasons behind
a design choice. A replacement model can work from the same history. This is a
way to extend the reach of human projects across changes in attention, membership,
and tools.

That continuity can also cross generations when people deliberately preserve and
pass on their archives. What survives is accessible information and its potential
use by others. Preserving someone's writing or preferences does not establish that
their subjective experience survives, or that an agent speaking from their archive
is the same person. Mind uploading and personal immortality require claims this
architecture cannot support.

An archive's authority remains a human decision. Who can contribute, correct,
retire, or inherit records shapes the resulting collective memory. In this small
implementation, filesystem access determines who can operate on a database;
there are no per-user permissions. Retirement excludes a record from recall but
retains it on disk. Broader sharing would need deliberate ownership and deletion
policies, alongside any technical expansion.

### Persistent identity, replacement, and forks

The database UUID gives a continuing store a name. Its memories and task history
give that name substance. Restarting workers preserves both. Changing the model
can preserve the records while changing how they are interpreted, so continuity
of history does not imply continuity of behavior.

A backup makes this distinction concrete. Restoring it recovers saved state.
Running two writable copies creates two histories that begin with the same UUID.
They can subsequently disagree. arm-mem does not merge those branches or decide
which one owns the original identity. A shared identifier alone cannot provide
agreement between disconnected systems.

The useful engineering commitment is narrower and testable: a fresh worker can
retrieve relevant evidence left earlier, use it, and leave a result for later work.
Durability, provenance, review, and recovery make that possible. Long lifetimes
would additionally require ongoing backups, migrations, and stewardship.

### Why the implementation stays small

The biological inspiration produced five mechanisms: persistent storage, retrieval,
a queue, temporary workers, and recovery. Each has a direct job. Adding elaborate
agent hierarchies would introduce coordination questions before we know whether
the basic memory helps.

Start with one worker and a useful archive. Add concurrent workers when there is
independent queued work. Add retrieval methods when actual questions expose
missed evidence. Introduce a service or server database if work must span machines.
The present package keeps these decisions visible in ordinary TypeScript and SQL.

Recovery is also explicit. Claims have a six-minute lease, and stale workers cannot
commit after losing it. A later invocation can retry expired work, up to three
attempts; it does not run a background recovery service. Execution is at least
once, so a crash can cause a model request to be repeated. Backups protect retained
state only when they are made and kept somewhere that survives the relevant failure.

## Tested result

On **BEAM 100K contradiction resolution** (40 questions across 20 conversations),
arm-mem scored **77.81%**: about **20.4 percentage points ahead** of the stronger
OptMem setup we tested, and about **0.3 points below**
[Past's published 78.13%](https://past.dev/benchmarks).

| System / configuration | Answer model | Score | Run basis |
| --- | --- | ---: | --- |
| **arm-mem**, default prompt | DeepSeek Flash / max | **77.81%** | One complete run |
| [OptMem](https://github.com/VictorTaelin/OptMem), native wake/search context | DeepSeek Flash / max | 57.40% | Three-run mean |
| [OptMem](https://github.com/VictorTaelin/OptMem), selected notes after search | DeepSeek Flash / max | 51.67% | Three-run mean |
| [Past](https://past.dev/benchmarks), published reference | GPT-5.6 Luna / none | 78.13% | External published run |

The published reference comes from [Past](https://past.dev/), a company selling a
managed long-term memory API for AI agents. Its business model combines usage
credits, monthly subscriptions, and enterprise contracts.

[Past's pricing](https://past.dev/pricing), checked on **2026-10-18**:

| Plan | Price | Included usage |
| --- | --- | --- |
| Pay as you go | $0/month; credit packs from $30 per 100,000 credits | 150,000 starter credits once, or 400,000 with a work email |
| Flex | $99/month, plus extra credits as needed | 400,000 credits/month and unlimited recall |
| Enterprise | Custom annual agreement | From 5,000,000 credits/month and unlimited recall |

Ingestion costs one credit per 350 bytes, rounded up per item. Pay-as-you-go
recall and answer calls cost 0.1 credit each; Flex and Enterprise do not meter
those calls. These are service-plan prices, separate from benchmark-run costs.
[Pricing details](https://past.dev/pricing).

All use GPT-5.6 Luna as judge. Our OptMem numbers come from earlier experiments
using a batch-import adapter and a different answer prompt. Past uses a different
answer model. These are partial-credit scores for one ability, rather than
overall BEAM scores or a controlled ranking of memory systems. The large gap to
the tested OptMem setups is encouraging; the small gap to Past is numerical
closeness, not established equivalence. [Protocol and validation](VALIDATION.md).

## Test and share

```sh
npm test          # 14 offline tests
npm run test:live # optional: one paid API call
npm pack          # produces arm-mem-0.1.0.tgz
```

The tarball includes source, types, CLI, examples, and tests. It excludes API keys
and databases. Recipients supply their own key. MIT licensed.
