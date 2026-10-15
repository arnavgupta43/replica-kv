# mini-dynamo — High-Level Design

> Scope of this document: **what** we are building and **how the parts behave together**.
> Code, libraries, and data structures belong in the low-level design, not here.

---

## 1. What we are building

A small **key-value store** (think tiny Redis / DynamoDB) where:

- you can **`put(key, value)`** and **`get(key)`**,
- every key is **stored on 3 machines** (replicas), so losing one does not lose data,
- the system **keeps working when a replica is down**,
- and replicas **eventually become identical** after failures stop (*eventual consistency*).

The goal is not a production database. It is a **lab** for killing machines and watching the system heal itself.

---

## 2. The big picture

```
                    ┌──────────┐
                    │  Client  │   put / get
                    └────┬─────┘
                         │
              ┌──────────▼───────────┐        ┌────────────┐
              │     Coordinator      │───────▶│ Hint Store │
              │ (talks to replicas,  │        │ (missed    │
              │  decides success)    │        │  writes)   │
              └──┬────────┬───────┬──┘        └─────┬──────┘
                 │        │       │                 │ replay later
           ┌─────▼──┐ ┌───▼────┐ ┌▼───────┐         │
           │Replica │ │Replica │ │Replica │◀────────┘
           │   A    │ │   B    │ │   C    │
           └────┬───┘ └───┬────┘ └───┬────┘
                └─────────┴──────────┘
              Background anti-entropy
           (replicas compare & fix each other)
```

---

## 3. Components and their single responsibility

| Component | What it is | Does | Does NOT |
|---|---|---|---|
| **Client** | You / a test script | Sends put/get | Know about replicas |
| **Coordinator** | The front door | Sends each request to all 3 replicas, waits for "enough" answers, returns the result | Store data itself |
| **Replica (×3)** | A storage node | Holds a full copy of the data; accepts a write only if it is newer than what it has; **persists every write to disk before acking** and restores its data on restart | Know about quorums or clients |
| **Hint Store** | Coordinator's "missed delivery" pile | Remembers writes a down replica missed; redelivers them when it is back | Act as a source of truth |
| **Anti-entropy** | Background process between replicas | Periodically compares data with peers and copies over whatever the other side is missing | Sit on the request path |

---

## 4. The one rule that makes everything work

> **Every value carries a version. A replica keeps the higher version and ignores the lower one.**

Consequence: it does not matter **how** or **how many times** a write reaches a replica — from the client, read-repair, a hint, or anti-entropy. The replica always ends up with the newest value. Applying a write is **idempotent** and **order-independent**.

This is why the healing mechanisms can work independently, without coordinating with each other.

---

## 4.1 Durability — an ack is a promise

> **A replica acknowledges a write only after it is safely on disk.**

Why this matters: the quorum guarantee (§5.3) assumes that a replica which acked a write **still has it** later. If a replica kept data only in memory, a restart would silently break that:

```
put(k, v2) → acked by A and B   (W=2 ✓, client told "OK")
B crashes, restarts with empty memory
get(k)     → answered by B (nothing) and C (old v1)
           → client sees v1 — an acknowledged write has vanished
```

Replica storage behaviour (write-ahead log pattern):

| Moment | What the replica does |
|---|---|
| **On write** | Append the record to a log file on disk and flush it → update memory → ack |
| **On startup** | Replay the log to rebuild memory |
| **Periodically (optional)** | Compact the log into a snapshot so it does not grow forever |

Result: a restarted replica comes back with everything it ever acked. It only misses writes made **while it was down** — exactly what hinted handoff and anti-entropy repair.

---

## 5. Main flows

### 5.1 Write — `put(k, v)`

```
Client → Coordinator: put(k, v)
Coordinator assigns a version, sends to A, B, C
   A ✓   B ✓   C ✗ (down)
2 of 3 acked (W=2) → tell client "OK"
C's missed write → Hint Store
```

**Rule:** a write succeeds when **2 of 3** replicas confirm (W = 2).

### 5.2 Read — `get(k)`

```
Client → Coordinator: get(k)
Coordinator asks A, B, C
   A: v2    B: v1 (stale)    C: no answer
2 answered (R=2) → return the newest (v2)
Side effect: send v2 to B   ← read-repair
```

**Rule:** a read succeeds when **2 of 3** replicas answer (R = 2); the client gets the newest version among them.

### 5.3 Why 2 and 2?

With N = 3 replicas, any 2 replicas that accepted a write and any 2 replicas answering a read **must share at least one replica**, because `W + R > N` (2 + 2 > 3).
So a read always reaches at least one replica holding the latest successful write.

### 5.4 Healing — three repair paths

| Path | Triggered by | Heals | Speed |
|---|---|---|---|
| **Read-repair** | Someone reading a key | That one key | Immediate, but only keys that are read |
| **Hinted handoff** | Replica coming back up | The writes it missed while down | Within seconds |
| **Merkle anti-entropy** | Periodic timer | **Anything** still different | Slow, but complete — the safety net |

They are layered: **fast and narrow → slow and complete.**

### 5.5 Write semantics — what "success" and "failure" mean

| Client sees | Meaning |
|---|---|
| **Success** | The write is durable on **at least W = 2** replicas and will be visible to every subsequent quorum read |
| **Failure** | **Unknown outcome.** The write may have reached fewer than W replicas — it may or may not become visible later. The client should **retry** (safe: a newer version simply wins) |

A "failed" write can still appear later:

```
put(k, v2) → A acks, B and C time out
           → 1 ack < W=2 → client gets "FAILED"
...later, anti-entropy copies v2 from A to B and C
get(k)     → v2   ← a write the client was told failed
```

This is the deliberate trade-off of Dynamo-style systems: **availability over atomicity.** Partial writes are not corruption — they are writes that have not finished spreading yet, and the repair mechanisms finish the job.

### 5.6 Why not two-phase commit (2PC)?

2PC gives *all-or-nothing* commit across participants, but it works against this system's goals:

| 2PC property | Consequence here |
|---|---|
| Needs **every** participant to vote yes | One replica down → no writes at all; we want to keep writing while C is dead |
| Coordinator crash between *prepare* and *commit* leaves participants **blocked** | The system stalls — the opposite of high availability |
| Extra round-trip on every write | Higher latency |

Running 2PC over only the reachable replicas (A, B) still blocks on coordinator failure and gives no guarantee for C — the cost without the benefit.

**If strict "committed means committed, or definitely not" is required**, the right tool is **consensus** (Raft / Paxos — etcd, ZooKeeper, Spanner), a different class of system:

| | This project (Dynamo-style) | Consensus (Raft) |
|---|---|---|
| Leader | None | One leader |
| Write succeeds when | W replicas ack | A majority commits through the leader's log |
| Failed write | Might still appear later | Definitely did not happen |
| Healing | Read-repair, hints, anti-entropy | Leader replicates its log to followers |
| Optimises for | Availability | Correctness / ordering |

---

## 6. Failure scenarios the system must handle

| Scenario | Expected behaviour |
|---|---|
| 1 replica down | Reads and writes still succeed (2 of 3); hints accumulate for the down replica |
| Replica crashes and restarts | It restores its data from disk; it is missing only the writes made while it was down |
| Replica comes back | Hints replayed → it catches up |
| Replica down for a long time / hints lost | Anti-entropy finds the differences and fixes them |
| 2 replicas down | Requests **fail** — the system refuses rather than lie (consistency trade-off) |
| A replica holds stale data | Reads still return the newest value; read-repair fixes the stale copy |
| Write reaches only 1 replica | Client told "failed" (unknown outcome); the value may still spread later via repair |
| Replica **partitioned** (alive, but unreachable over the network) | To the coordinator it looks like "down": quorum continues with the other 2, hints accumulate. It keeps its own data and serves nothing new. When the partition heals, hints and anti-entropy bring it up to date |
| Coordinator down | System unavailable — a known, accepted limitation for now |

---

## 7. Deployment

Every component runs as a **separate service**. Replicas never share memory or files — they only talk over the network, like real machines.

### 7.1 Topology (Docker Compose)

```
            ┌─────────────────────────── docker network ───────────────────────────┐
            │                                                                       │
 Client ───▶│  coordinator :4000 ──────┬──────────────┬──────────────┐              │
            │      │                   │              │              │              │
            │  [vol: coord-data]  replica-a :4001  replica-b :4002  replica-c :4003 │
            │   (hints, if        [vol: a-data]   [vol: b-data]   [vol: c-data]     │
            │    persisted)            └──── anti-entropy (peer to peer) ────┘      │
            └───────────────────────────────────────────────────────────────────────┘
```

| Service | Volume | Holds |
|---|---|---|
| `coordinator` | `coord-data` | Version counter (must survive restarts); hint store too, if hints are persisted — see §11 |
| `replica-a` / `-b` / `-c` | One **dedicated** volume each | That replica's write-ahead log / snapshots |

A replica's volume outlives its container: kill or even recreate the container, and the data is still there.

### 7.2 Configuration, not code

Each service learns everything about its environment from configuration, so the **same code** runs anywhere:

| Setting | Meaning | Example |
|---|---|---|
| `NODE_ID` | This node's identity | `replica-b` |
| `PORT` | Port to listen on | `4002` |
| `DATA_DIR` | Where this node stores its files | `/data` |
| `PEERS` | Addresses of the other replicas (replicas: for anti-entropy; coordinator: all replicas) | `replica-a:4001,replica-c:4003` |

Nothing is hard-coded to `localhost` or a fixed folder.

### 7.3 Two run modes

| Mode | How | Used for |
|---|---|---|
| **Local processes** | 1 coordinator + 3 replica processes, each with its own port and data folder | Fast development loop; tests in Phases 1–5 |
| **Docker Compose** | One container per service, one volume per replica | Realistic runs, demos, and the Phase 6 chaos test |

### 7.4 Failure injection in Docker

| Failure | How to cause it | What it simulates |
|---|---|---|
| Crash | `docker kill <replica>` | Process dies instantly, no graceful shutdown |
| Restart | `docker start <replica>` | Machine comes back with its disk intact |
| Partition | `docker network disconnect` / `connect` | Replica alive but unreachable |

**Limit of realism:** `docker kill` kills the process, not the machine — the host OS still flushes buffered writes to disk. So Docker will **not** catch a missing `fsync` before ack; only real power loss would. Acceptable for learning, but worth knowing.

---

## 8. Success criterion

> Run random writes while randomly **crashing, restarting, and partitioning** replicas. Stop the chaos, wait, then verify:
> 1. **All 3 replicas hold identical data**, and
> 2. **Every write the client was told succeeded is present** — including on replicas that crashed and restarted.

---

## 9. Out of scope (for now)

- Sharding / consistent hashing — every replica stores **all** keys
- Multiple coordinators — the coordinator is a single point of failure
- External databases — each replica uses its own simple on-disk log, not Postgres/RocksDB/etc.
- Atomic (all-or-nothing) commit across replicas — no 2PC, no consensus (see §5.6)
- Concurrent-write conflict resolution beyond "highest version wins" (no vector clocks)
- Security / authentication
- Orchestration beyond Docker Compose (Kubernetes, multi-host)

---

## 10. Build order

| Phase | Capability added |
|---|---|
| 1 | **Replicas** that store versioned values and **persist them to disk** (survive restart); configurable via `NODE_ID` / `PORT` / `DATA_DIR` / `PEERS` |
| 2 | **Coordinator** with 2-of-3 reads and writes (quorum) |
| 3 | **Read-repair** |
| 4 | **Hinted handoff** |
| 5 | **Merkle anti-entropy** (v1: flat bucket hashes, v2: binary tree) |
| 6 | **Docker Compose cluster + chaos test** (crash, restart, partition) proving convergence |

Each phase adds exactly one capability and can be tested on its own.

---

## 11. Open questions (to settle in the low-level design)

- **Versioning:** who generates versions, and how are ties broken so two replicas never disagree on "which is newer"?
- **Persistence details:** log record format, how often to flush, when/how to compact into a snapshot.
- **Hint durability:** should the Hint Store also persist to disk, or is losing hints on coordinator crash acceptable (anti-entropy will cover it)?
- **Deletes:** how to delete without anti-entropy "resurrecting" the key (tombstones)?
- **Hints and quorum:** does a stored hint count toward W (Dynamo's *sloppy quorum*) or not?
