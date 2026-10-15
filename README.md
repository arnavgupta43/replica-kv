# mini-dynamo (replica-kv)

A small, **leaderless, replicated key-value store** built for learning — a hands-on way to understand how systems like Amazon Dynamo, Cassandra, and Riak stay available and eventually consistent when machines fail.

> Status: **put, get, read-repair, hinted handoff and anti-entropy (v1) working.** Next: Merkle tree (v2). Design: [`docs/HLD.md`](docs/HLD.md).

---

## Why this project exists

Reading about distributed systems (e.g. *Designing Data-Intensive Applications*) introduces ideas like:

> *Replicas periodically compare state and heal divergence. Merkle trees find the differing ranges without shipping all the data. Read-repair fixes stale replicas on the read path. Hinted handoff stores writes for a down replica and replays them when it comes back.*

This project implements each of those ideas in a minimal form, so they can be **seen, broken, and tested** rather than only read about.

---

## What it does

- `put(key, value)` and `get(key)` over HTTP
- Every key is stored on **3 replicas**
- Reads and writes succeed when **2 of 3** replicas respond (quorum: N=3, W=2, R=2)
- Each replica **persists writes to disk before acking**, so a crash never loses acknowledged data
- Survives a replica going down, and **heals it** when it returns

### What "success" means

| Client sees | Meaning |
|---|---|
| **Success** | Durable on at least 2 of 3 replicas; will be visible to later reads |
| **Failure** | Unknown outcome — the write may still appear later. Retry is safe. |

There is **no two-phase commit**: this is a Dynamo-style system that favours availability over atomicity. Partial writes are finished by the repair mechanisms. (Why, and the consensus alternative: [HLD §5.5–5.6](docs/HLD.md#55-write-semantics--what-success-and-failure-mean).)

## Core concepts

| Concept | One-line summary |
|---|---|
| **Versioned values** | Every value carries a version; replicas keep only the highest. Makes every write idempotent. |
| **Durable acks (write-ahead log)** | A replica writes to its on-disk log before acking and replays the log on restart. |
| **Quorum reads/writes** | `W + R > N` guarantees a read overlaps the latest successful write. |
| **Read-repair** | While reading, push the newest value to any replica that returned a stale one. |
| **Hinted handoff** | Writes a down replica missed are queued and replayed when it comes back. |
| **Merkle anti-entropy** | Replicas compare hashes of their data to find and fix differences without sending everything. |
| **Chaos testing** | Kill and restart replicas during writes, then prove all replicas converge. |

## Architecture

```
Client ──▶ Coordinator ──▶ Replica A / B / C
               │                  ▲
               └──▶ Hint Store ───┘ (replay)

        Replicas ◀── anti-entropy ──▶ Replicas
```

Full design: [`docs/HLD.md`](docs/HLD.md)

### Deployment

Each component is a **separate service** — in Docker, one container per service and **one volume per replica**, so every replica has its own durable disk, like a real machine.

| Service | Port | Volume |
|---|---|---|
| `coordinator` | 4000 | `coord-data` (version counter) |
| `replica-a` | 4001 | `a-data` |
| `replica-b` | 4002 | `b-data` |
| `replica-c` | 4003 | `c-data` |

The same code runs in two modes, configured via `NODE_ID`, `PORT`, `DATA_DIR`, `PEERS`:

- **Local processes** — fast dev loop and tests
- **Docker Compose** — realistic cluster for demos and chaos testing (crash with `docker kill`, partition with `docker network disconnect`)

Details: [HLD §7](docs/HLD.md#7-deployment).

---

## Roadmap

- [x] **Phase 1** — Replica: store that only accepts higher versions, persisted to an on-disk log
- [x] **Phase 2** — Coordinator: quorum put/get (N=3, W=2, R=2)
- [x] **Phase 3** — Read-repair (fire-and-forget)
- [x] **Phase 4** — Hinted handoff: coordinator pushes hints every 5s, deletes on OK, drops after a TTL
- [ ] **Phase 5** — Merkle anti-entropy — *v1 (1024 flat bucket hashes) done; v2 (binary tree) next*
- [ ] **Phase 6** — Docker Compose cluster + chaos script: crash/restart/partition replicas, assert convergence

## Tech stack

- Node.js 22 + plain JavaScript (ES modules)
- Express for HTTP
- Per-replica append-only log file on disk + in-memory index (no external DB)
- Docker + Docker Compose (one container per service, one volume per replica)

## Getting started

### Project structure

```
src/
  config.js              settings from env vars (NODE_ID, PORT, DATA_DIR, REPLICAS, PEERS)
  shared/
    replicaClient.js     HTTP calls to a replica (send a value, read a value, fetch JSON)
  replica/
    store.js             in-memory Map + append-only log on disk (only higher versions win)
    merkle.js            bucket of a key, bucket hashes, bucket entries (Merkle v1)
    antiEntropy.js       every 10s: sync with a random peer, pull newer / push newer
    server.js            HTTP: PUT/GET /kv/:key, GET /merkle, GET /bucket/:i
  coordinator/
    version.js           version counter, persisted to disk
    hints.js             hint store + replay loop (in-memory, TTL-bounded)
    put.js               put path: parallel send, 2-of-3 quorum, hints on failure
    get.js               get path: 2-of-3 quorum read, newest wins, read-repair
    server.js            HTTP: PUT /kv/:key {value}, GET /kv/:key, GET /hints
env/                     one .env file per service for local runs
Dockerfile               one image for all services
docker-compose.yml       coordinator + 3 replicas, one volume each
```

### Run locally (4 terminals)

```bash
npm install
npm run replica:a
npm run replica:b
npm run replica:c
npm run coordinator
```

Data goes to `./data/<service>/`.

### Run with Docker

```bash
docker compose up --build
```

### Try it

```bash
# write through the coordinator
curl -X PUT localhost:4000/kv/x -H "Content-Type: application/json" -d '{"value":"hello"}'

# read through the coordinator (newest of 2 replicas; stale replicas get repaired)
curl localhost:4000/kv/x

# look at each replica's own copy
curl localhost:4001/kv/x
curl localhost:4002/kv/x
curl localhost:4003/kv/x

# stop one replica, write again, then see the hint the coordinator kept for it
curl localhost:4000/hints
```

## Out of scope

Sharding / consistent hashing, multiple coordinators, external databases, atomic cross-replica commit (2PC / consensus), vector clocks, auth. See [HLD §9](docs/HLD.md#9-out-of-scope-for-now).

## References

- *Designing Data-Intensive Applications* — Martin Kleppmann, Ch. 3 (Storage — logs), Ch. 5 (Replication), Ch. 9 (Consistency & Consensus)
- [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) (DeCandia et al., 2007)
