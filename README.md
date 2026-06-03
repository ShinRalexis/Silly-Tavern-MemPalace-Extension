![MemPalace](extension/Banner.jpg)

# MemPalace

> **Semantic long-term memory for SillyTavern characters.**
> Beyond keywords — MemPalace gives your AI characters a real, persistent, searchable memory built on vector embeddings and a knowledge graph.

[![Version](https://img.shields.io/badge/version-3.10.0-blue)](https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension/releases)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-compatible-green)](https://github.com/SillyTavern/SillyTavern)
[![License](https://img.shields.io/badge/license-MIT-orange)](LICENSE)

---

## What it does

SillyTavern's native memory is limited to a fixed context window. MemPalace replaces that with a full cognitive architecture:

- **Semantic RAG** — retrieves relevant memories based on meaning, not keywords
- **Knowledge Graph** — tracks facts, relationships and events as structured triples (Subject → Predicate → Object)
- **Memory Nucleus** — a permanent "core biography" always injected into the prompt
- **Lorebook ingestion** — teach entire lorebooks to a character once; they surface naturally during chat
- **AAAK compression** — compact memory encoding that saves up to 30x token space
- **Timeline** — chronological view of all recorded events for a character

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- **Docker Desktop** (recommended) or **Python 3.11+**
- Git

---

## Installation

Clone the repo anywhere on your PC and run the installer:

```powershell
git clone https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension
cd MemPalace
.\install.ps1
```

The installer will:

1. **Detect SillyTavern** automatically (or ask you for the path)
2. **Install the extension** into your SillyTavern extensions folder
3. **Set up the server** — Docker or Python direct, your choice
4. **Create `Documents\MemPalaceMemories`** — all memories saved on your PC, never inside the container

At the end, both the extension and the server are fully working.

> **Already have MemPalace installed?**
> The script detects your existing container and updates the server files without touching your memories.

---

## Updating

```powershell
cd MemPalace
git pull
.\install.ps1 -Update
```

This updates both the extension and the server in one step.

**Reconfigure paths (ST location, server location):**
```powershell
.\install.ps1 -Configure
```

---

## Where memories are stored

On first install, the script creates:

```
Documents\
└── MemPalaceMemories\
    ├── data\      <- ChromaDB vectors (semantic memories)
    └── config\    <- Knowledge Graph SQLite + settings
```

Your memories live on your PC. The Docker container can be deleted and recreated without losing anything.

---

## Configuration

Once enabled in SillyTavern (Extensions panel), configure MemPalace from its settings tab:

| Setting | Description |
|---|---|
| Memory Isolation | **Global** (all chats) or **Isolated** (per chat session) |
| RAG Relevance Threshold | 0.0 = retrieve everything / 1.0 = strict matches only |
| RAG Budget | Max characters injected per generation (default: 2000) |
| AAAK Compression | Compact token encoding — recommended for long sessions |
| Auto-scan | Automatically sync new messages to memory |

---

## Lorebook Ingestion

1. Extensions → MemPalace → **Lorebook Ingestion**
2. Select a lorebook from the dropdown
3. Click **Ingest Lore** (confirm twice)

All entries are ingested — `{{char}}` expands to the character name, `{{user}}` becomes `you`. Only entries tagged `[NO-RAG]` are skipped.

---

## Knowledge Browser

- **Timeline** — chronological events for the current character
- **Entity Registry** — all known facts grouped by subject
- **Deep Scan** — full historical analysis of the chat
- **Synaptic Map** — interactive graph visualization

---

## Backup & Restore

**Export** all memories (vectors + KG facts + diary) to a JSON file via the **Backup** button in the panel.

**Restore** from a backup JSON with the **Restore** button. Supports export formats v1 and v2.0.

---

## Integration with Silly Quantum

MemPalace integrates with [Silly Quantum](https://github.com/ShinRalexis/SillyQuantum) via a shared bridge:

- Chaotic quantum state (`111xxx`/`110xxx`) → increases personal memory retrieval
- Oracle twists → saved automatically to the character's `lore` room
- Judgement outcomes → saved automatically to the character's `char` room

---

## Repository Structure

```
MemPalace/
├── install.ps1        <- installer and updater (run this)
├── README.md
├── LICENSE
├── extension/         <- SillyTavern extension files
│   ├── index.js
│   ├── manifest.json
│   ├── style.css
│   ├── index.html
│   └── vis-network.min.js
└── server/            <- Python backend
    ├── bridge.py
    ├── mcp_server.py
    ├── docker-compose.yml
    ├── Dockerfile
    └── requirements.txt
```

---

## Privacy

All data is stored **locally on your machine** in `Documents\MemPalaceMemories`. Nothing is sent to external services.

---

## License

MIT License — see [LICENSE](LICENSE)

---

*Made by [ShinRalexis](https://github.com/ShinRalexis)*
