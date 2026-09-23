![MemPalace](extension/Banner.jpg)

# Silly Tavern MemPalace Extension

> **Semantic long-term memory for SillyTavern characters.**
> Beyond keywords, MemPalace gives your AI characters a real, persistent, searchable memory built on vector embeddings and a knowledge graph.

[![Version](https://img.shields.io/badge/version-5.9.0-blue)](https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension/releases)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-compatible-green)](https://github.com/SillyTavern/SillyTavern)
[![MemPalace](https://img.shields.io/badge/MemPalace-compatible-green)](https://github.com/milla-jovovich/mempalace)
[![License](https://img.shields.io/badge/license-MIT-orange)](LICENSE)

---

## What it does

SillyTavern's native memory is limited to a fixed context window. MemPalace replaces that with a full cognitive architecture:

- **Semantic RAG**: retrieves relevant memories based on meaning, not keywords
- **Character identity**: the character card itself becomes memory, so the character always knows who they are
- **Knowledge Graph**: tracks facts, relationships and events as structured triples (Subject, Predicate, Object)
- **Salience and forgetting**: memories are weighted by how much they matter to *this* character, fade with time and grow stronger each time they are recalled
- **Inner thoughts**: after each turn the character keeps a short first-person thought; what keeps coming back becomes a lasting trait
- **Shared lore**: each lorebook is learned once and shared by every character who lives in that world
- **Memory Nucleus**: a permanent "core biography" always injected into the prompt
- **AAAK compression**: compact memory encoding for long sessions
- **Timeline, Entity Registry and Synaptic Map**: see what the character knows and how it connects

---

## What's new in 5.9 (since 3.10)

### Interface

- The settings panel is reorganized into seven sections: **Character memory** (who they are, what they remember, where their memory ends), **World and lore**, **Knowledge**, **How memories are retrieved**, **How memories are recorded**, **Maintenance** and **Interface**. Every new label is translated into all 7 languages (English, Italiano, Español, Français, Deutsch, 日本語, 中文).
- New **Linked lore** manager: see every world already in the archive and tick the ones a character knows, without ingesting the lorebook again.
- New switches: **Extract facts with the model** and **Read lore in the background**.
- The sliders now say what they do at each end (Everything / Only relevant, Compact / Full, Concise / Detailed).
- Panel statistics (drawers, graph nodes, facts) now describe the character you have open. Before, every character showed the same global totals.
- Switching character immediately removes the previous character's RAG block, so the *Last RAG injection* panel and the prompt never show someone else's memories.
- **Synaptic Map**: shows only the open character's memory, and recognises the protagonist node in both isolation modes.
- The **AAAK savings** indicator, which never lit up before, now shows a real measurement taken on the character's own memories.

### Memory model

- **Three kinds of wing**: an *identity* wing per character (card, links to lore, thoughts), *episodic* wings for the chats, and one *shared* wing per lorebook. Wiping a character's memory never touches the shared lore, and the Memory Nucleus survives a wipe.
- **Character card as memory**: description, personality, scenario and character note are stored in the identity wing and rewritten only when the card actually changes. Example dialogues, creator notes and system prompts are deliberately left out: they are style samples and instructions, not memories.
- **Chat openings** are stored as their own type. Episodic retrieval skips them, so in shared mode the character does not recall the opening of a different storyline.
- **Canonical wing names**: `Name`, `Name-X` and `Name_X` always resolve to the same wing. Memory no longer fragments across spelling variants.
- **Long memories are split** into overlapping pieces cut at sentence boundaries, so the end of a long message is no longer lost.

### Retrieval

- Every candidate memory gets a **score**: similarity 40%, salience 25%, freshness 20%, rehearsal 15%.
- **Half-lives by type**: card and lore never fade, chat openings last 120 days, scenes 21 days, thoughts 3 days.
- **Salience per character**: the model rates how much a scene matters along the character's own axes of attention. The same scene can weigh 0.2 for one character and 0.9 for another, so different characters remember different things.
- The **relevance threshold** now compares a real cosine similarity. The old value was `2·cos - 1`, so the slider asked for roughly twice what it showed and discarded most results at 0.3.
- Facts that are no longer true (invalidated) are no longer injected.
- The user's own words are no longer injected as the character's lived experiences.
- Phase E (social graph) stays inside the character's memory: common words can no longer bridge into other characters' facts.
- Phase A searches the lore wings linked to the character.
- The injected memory header was rewritten, so the model no longer imitates bracketed labels in its replies.
- Text tagged `[SECRET]`, `[PRIVATE]` or `[HIDDEN]` (also `[SEGRETO]`, `[PRIVATO]`, `[NASCOSTO]`) is kept out of the prompt.

### Knowledge Graph

- **Fact extraction with the model** (optional): uses the model already connected in SillyTavern, both continuously and in Deep Scan. It finds far more than the regex extractor: in our tests, 27 facts from 12 messages, including things the regex cannot see. It works after the turn, two messages at a time, never during a generation, and falls back to regex automatically if the model does not answer.
- Facts that exclude each other replace the old one: when a character moves, `lives_in` closes the previous city instead of keeping both.
- Re-syncing a chat after a wipe rebuilds the graph, Timeline and Entity Registry. Before, they stayed empty.
- Regex extractor fixes: removed a pattern that produced about two thirds of all triples as noise, fixed a character-class bug that swallowed punctuation into names, normalized artifacts like `To Name` or `Key: ...`, and the extractor and the cleanup now share one noise-word list.
- Name variants with hyphens, spaces or underscores resolve to the same entity, so no facts become unreachable.
- Wipes match wing names exactly: deleting `Eva` no longer deletes `Eva_Neri` too.
- The Timeline shows events only and keeps lore facts out. Archiving a fact from the Entity Registry now works across both the episodic and the identity wing.

### Lore

- Each lorebook is **distilled once per book**; the facts are then copied into every character who uses it (about 150 ms per fact instead of distilling the book again).
- **Background reading**: lore is distilled only while the chat has been idle for a minute, with pauses proportional to the work done, so the GPU stays busy less than a quarter of the time. It can be switched off.
- Lore facts are ready as soon as a chat opens.

### Inner life (new)

Active when **Extract facts with the model** is on:

- After each turn the character rates how much the scene mattered and writes a short first-person thought (the `pensiero` room, 3-day half-life). The latest thoughts give continuity from one turn to the next.
- **Consolidation**: what keeps coming back in the thoughts becomes a lasting fact about the character, marked as such and kept out of the Timeline.

### Server

- Tool calls run in a thread pool: the six RAG phases now cost as much as the slowest one, not the sum of all six.
- Search across several wings at once (`wings`), room exclusion lists, and a real cosine score in every result.
- Statistics, graph, neighbours and invalidation can be limited to one character's wings.
- `mempalace_kg_add` keeps `source_file`; `mempalace_add_drawer` accepts a per-write duplicate threshold.
- The ChromaDB client is cached and thread-safe.
- Optional **multilingual embeddings** (E5 family, ONNX) with a re-index script. See [Multilingual embeddings](#multilingual-embeddings-optional).
- Dependencies: **ChromaDB 1.x**. `sentence-transformers` was removed (it was never used and pulled in PyTorch): the Docker image is now about 560 MB.
- Security: CORS accepts only a local SillyTavern, and the server listens on loopback unless told otherwise. The Docker binding was fixed so the published port actually reaches the server.
- The installer's update now rebuilds the container, so new dependencies are installed.

---

## How it works

### Architecture

MemPalace operates as two components that work together:

```
SillyTavern (browser)              MemPalace Server (localhost:8052)
+---------------------+            +------------------------------+
|  extension/index.js |            |  bridge.py  (FastAPI)        |
|                     |  HTTP/JSON |  mcp_server.py  (~30 tools)  |
|  Generate           |<---------->|                              |
|  Interceptor        |            |  ChromaDB  (vector search)   |
|                     |            |  SQLite KG (fact triples)    |
|  UI Panel           |            |  Diary     (permanent notes) |
+---------------------+            +------------------------------+
```

Every time the AI is about to generate a response, the **generate interceptor** fires, queries the server, retrieves relevant memories, and injects them into the prompt before the LLM sees it.

### Wings

| Wing | Content |
|---|---|
| **Identity** | Character card, lore links, thoughts (the Memory Nucleus has a wing of its own) |
| **Episodic** | What happened in the chats |
| **Lore** | One shared wing per lorebook |

Wiping a character's memory never touches the lore wings, and the Memory Nucleus survives it.

### Memory Layers

Inside each wing, memories are stored in typed **Rooms**:

| Room | Content | Injected in prompt |
|---|---|---|
| `lore` | Lorebook entries, world facts, Oracle twists | Yes, with cooldown rotation |
| `char` | AI responses, Judgement outcomes | Yes, episodic retrieval |
| `user` | User messages | Yes, as context, never as the character's own experience |
| `pensiero` | The character's recent inner thoughts | Read by the next reflection, fades in 3 days |
| `secret` | Hidden facts | Never, KG only |

The character card and the chat opening are stored as their own types as well.

### Hexa-Phasic+ Retrieval Pipeline

On every AI generation, up to **6 parallel queries** are fired against the server:

| Phase | Query | Purpose |
|---|---|---|
| **A**: Lore | Semantic core of current message | World knowledge from the linked lore wings |
| **B**: Plot | Narrative arc of last 4 messages | Recent story momentum |
| **C**: Echo | Semantic core + emotional boost | Personal character memories |
| **D**: KG | Up to 3 named entities from message | Structured fact retrieval |
| **E**: Neighbors | Character's social graph (depth 2) | Relationship context, inside the character's own memory |
| **F**: KG Bridge | Objects/predicates from Phase D facts | Associative chaining |

Each phase has an independent `.catch()`, a failing phase never blocks the others. Results are merged, deduplicated, ranked by **score** (similarity, salience, freshness, rehearsal), and compressed to fit within the configured token budget.

### Knowledge Graph

Every message is parsed for named entities and fact triples, by regex or, if enabled, by the model. Facts are stored as:

```
Subject, Predicate, Object
"Character Name", "works_at", "Seventh Heaven"
"Character Name", "knows", "Friend"
```

The KG feeds Phase D (direct facts), Phase E (relationship graph), and Phase F (associative bridge queries). It also powers the **Timeline**, **Entity Registry**, and **Synaptic Map** visualizations.

### AAAK Dialect

AAAK is an optional semantic compression protocol. Instead of injecting full sentences, memories are encoded as compact tokens:

```
[E:SAD][ID:CN][F:MISS_FATHER][T:past][R:high]
```

It saves tokens at the cost of less natural reading. The panel shows the saving actually measured on the character's memories.

### Memory Isolation Modes

| Mode | Wing key | Behaviour |
|---|---|---|
| **Global** | `Character_Name` | All chats share one memory, historical continuity across sessions |
| **Isolated** | `Character_Name_chat_chatId` | Each chat has its own memory, ideal for parallel storylines or "What If" scenarios |

In both modes the character's identity (card, Nucleus, linked lore) stays the same.

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern), reachable on `localhost` or `127.0.0.1` at port 8000, 8080 or 8081 (see [Troubleshooting](#troubleshooting) for other ports)
- **Docker Desktop** (recommended) or **Python 3.11+**
- Git
- Optional: a model connected in SillyTavern, for fact extraction and inner thoughts

---

## Installation

### Quick install (Docker, recommended)

Clone the repo anywhere on your PC and run the installer:

```powershell
git clone https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension
cd Silly-Tavern-MemPalace-Extension
.\install.ps1
```

The installer will:

1. **Detect SillyTavern** automatically (or ask you for the path)
2. **Install the extension** into your SillyTavern extensions folder
3. **Set up the server**: Docker or Python direct, your choice
4. **Create `Documents\MemPalaceMemories`**: all memories saved on your PC, never inside the container

At the end, both the extension and the server are fully working. The first start downloads the embedding model (about 80 MB), so the server may need a minute before it answers.

> **Already have MemPalace installed?**
> The script detects your existing container and updates the server files without touching your memories.

### Manual install

If you prefer to manage the server yourself:

1. Copy the contents of `extension/` into `SillyTavern/public/scripts/extensions/MemPlace/` (the folder name must be `MemPlace`).
2. Copy the contents of `server/` to wherever your MemPalace server runs, then install its dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Start the server:

   ```bash
   MEMPALACE_PALACE_PATH=/path/to/data MEMPALACE_CONFIG_DIR=/path/to/config python bridge.py
   ```

   It listens on `127.0.0.1:8000` by default (`HOST` and `PORT` change that). The extension expects it at `http://localhost:8052`: either run it with `PORT=8052`, or use `docker compose up -d --build` from `server/`, which maps it there.

4. Restart SillyTavern and enable **MemPalace** in the extensions panel.

> [!WARNING]
> **Disable SillyTavern's built-in Vector Storage before using MemPalace!**
> Both systems manage AI memory and running them together causes conflicts. Go to Extensions > Vector Storage and disable it. MemPalace is designed to replace it entirely.

---

## Updating

```powershell
cd Silly-Tavern-MemPalace-Extension
git pull
.\install.ps1 -Update
```

This updates both the extension and the server in one step. With Docker the container is rebuilt, so new dependencies are installed; your memories stay in `Documents\MemPalaceMemories`.

**Updating from 3.x:** version 5.9 moves the server to ChromaDB 1.x. Archives created with the previous version open without migration steps (tested with an archive from ChromaDB 0.6), but a **Backup** from the panel before updating is still a good idea.

**Reconfigure paths:**

```powershell
.\install.ps1 -Configure
```

---

## Where memories are stored

On first install, the script creates:

```
Documents\
+-- MemPalaceMemories\
    +-- data\      <- ChromaDB vectors (semantic memories) + Knowledge Graph SQLite
    +-- config\    <- settings (and the optional multilingual embedding model)
```

Your memories live on your PC. The Docker container can be deleted and recreated without losing anything.

---

## Configuration

| Setting | Description |
|---|---|
| Memory Isolation | **Global** (all chats) or **Isolated** (per chat session) |
| RAG Relevance Threshold | 0.0 = retrieve everything / 1.0 = strict matches only (cosine similarity) |
| RAG Budget | Max characters injected per generation (default: 2000) |
| Max chars/fragment | Maximum length per individual memory fragment |
| Auto-scan if misaligned | Automatically sync messages not yet in memory |
| Extract facts with the model | Uses the connected model for facts, salience and thoughts. Off by default: it keeps the model busy for a few seconds after each turn |
| Read lore in the background | Distills linked lorebooks while the chat is idle. Needs model extraction on; switch it off if you hear the GPU working |
| AAAK Compression | Compact token encoding, fewer tokens, less natural reading |

---

## Lorebook Ingestion

1. Extensions -> MemPalace -> **World and lore**
2. Select a lorebook from the dropdown
3. Click **Ingest Lore** (confirm twice)

All entries are ingested: `{{char}}` expands to the character name, `{{user}}` becomes `you`. Only entries explicitly tagged `[NO-RAG]` are skipped. This is intentional, broad ingestion at storage time, precise retrieval at generation time via semantic search.

Each lorebook lives in its own shared wing. A new character who lives in a world that is already in the archive does not need to ingest it again: open **Linked lore** and tick the worlds they know.

---

## Memory Nucleus (Diary)

The **Nucleus** is a permanent text block always injected into the prompt, regardless of semantic relevance. Use it for:

- Fixed biographical facts (name, age, relationships)
- Traumas or defining events that should always be active
- Story rules that must never be forgotten

The Nucleus can be edited manually, loaded from a `.txt` file, or pre-populated from the Knowledge Graph via **Generate from KG**. It survives a memory wipe.

An **Auto-diary** runs every 20 generations, it summarizes the top KG facts and appends them to the Nucleus automatically.

---

## Knowledge Browser

Accessible from the MemPalace panel:

- **Timeline**: chronological events extracted from the KG, sorted by date (lore facts excluded)
- **Entity Registry**: all known entities and their associated facts
- **Deep Scan**: full historical analysis of the entire chat, batch-processed, with the model if enabled
- **Synaptic Map**: interactive force-directed graph of the character's entities and relationships (powered by vis-network)

---

## Multilingual embeddings (optional)

By default the server uses ChromaDB's built-in embedding model (all-MiniLM-L6-v2), which is trained on English. For memories in other languages you can switch to a multilingual model of the E5 family in ONNX format:

1. Put the model in `config/models/<folder>/` (it needs `tokenizer.json` and `onnx/model.onnx`).
2. Create `config/models/embedding.json`:

   ```json
   {"dir": "<folder>", "query_prefix": "query: ", "doc_prefix": "passage: "}
   ```

3. Stop the server and re-index the archive once (from `server/`):

   ```bash
   docker compose stop mempalace
   docker compose run --rm mempalace python reindex_multilingual.py
   docker compose start mempalace
   ```

> [!WARNING]
> Vectors from different models are not comparable. Changing model without re-indexing makes search useless. The re-index keeps the previous collection as a backup inside ChromaDB.

---

## Backup & Restore

**Export** exports a complete snapshot:

```json
{
  "palace_export_version": "2.0",
  "wing": "Character_Name",
  "drawers": { "total": 450, "items": [] },
  "kg": { "facts": [] },
  "diary": { "entries": [] }
}
```

**Restore** imports this snapshot. Supports both v1 (flat array) and v2.0 (object with metadata) formats.

---

## Integration with Silly Quantum

MemPalace integrates with [Silly Quantum](https://github.com/ShinRalexis/SillyQuantum) via a shared bridge (`window.__sillybridge`):

| Direction | Event | Effect |
|---|---|---|
| SQ -> MP | Chaotic quantum state (`111xxx`/`110xxx`) | +1 personal memory fragment per generation |
| SQ -> MP | Oracle twist generated | Saved to character's `lore` room automatically |
| SQ -> MP | Judgement outcome | Saved to character's `char` room automatically |
| MP -> SQ | RAG injection active | SQ reads MP bridge for cross-extension state |

The bridge is order-of-load independent, whichever extension loads first creates the shared object and the second one attaches to it. Quantum states are matched on the exact character name, so a character never reads another one's mood.

---

## Troubleshooting

- **The panel says the server is offline**: check that the server answers at `http://localhost:8052`. On the very first start it downloads the embedding model and can take a minute.
- **"No palace found"**: normal on a brand new install. The archive is created with the first memory saved.
- **SillyTavern runs on a port other than 8000, 8080 or 8081**: add its address (for example `http://localhost:5000`) to `allow_origins` in `server/bridge.py`, then restart the server.
- **Fact extraction finds nothing**: make sure a model is connected in SillyTavern. If it does not answer, MemPalace falls back to the regex extractor on its own.

---

## Repository Structure

```
Silly-Tavern-MemPalace-Extension/
+-- install.ps1        <- installer and updater (run this)
+-- README.md
+-- LICENSE
+-- extension/         <- SillyTavern extension (copied to ST/extensions/MemPlace/)
|   +-- index.js       <- main logic: interceptor, RAG pipeline, UI, KG browser
|   +-- manifest.json  <- ST extension manifest
|   +-- style.css      <- UI styles
|   +-- index.html     <- settings panel
|   +-- vis-network.min.js
+-- server/            <- Python backend (run via Docker or directly)
    +-- bridge.py      <- FastAPI server (POST /call/{tool_name})
    +-- mcp_server.py  <- ~30 tools (search, add, wipe, KG, diary...)
    +-- knowledge_graph.py  <- SQLite KG: extract, store, query triples
    +-- dialect.py     <- AAAK compression engine
    +-- searcher.py    <- ChromaDB semantic search wrapper
    +-- embed_multilingual.py   <- optional multilingual embeddings
    +-- reindex_multilingual.py <- re-index after changing embedding model
    +-- config.py      <- configuration (env vars > config file > defaults)
    +-- docker-compose.yml
    +-- Dockerfile
    +-- requirements.txt
```

---

## Privacy

All data is stored **locally on your machine** in `Documents\MemPalaceMemories`. The server runs entirely offline. Nothing is sent to external services.

---

## License

MIT License, see [LICENSE](LICENSE)

---

## Acknowledgements

The server backend (`server/`) is built on the [MemPalace](https://github.com/milla-jovovich/mempalace) Python library by MemPalace Contributors, released under the MIT License.

The SillyTavern extension (`extension/`), the FastAPI bridge (`server/bridge.py`) and the installer (`install.ps1`) are original work by [MetaDarko](https://github.com/ShinRalexis).

---

Author: [MetaDarko](https://github.com/ShinRalexis) · Contact: MetaDarko@pm.me

---

If you use Silly-Tavern-MemPalace-Extension regularly, consider supporting development. It helps keep the project alive and motivates new features.

<a href="https://mempool.space/it/address/179gN4aknE1R53w2yNJpiE4sp7nDucZ1He"><img src="https://wsrv.nl/?url=files.catbox.moe/3cojtz.png&h=30" align="absmiddle" alt="Bitcoin"> 179gN4aknE1R53w2yNJpiE4sp7nDucZ1He</a>

<a href="https://liberapay.com/MetaDarko/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a>
