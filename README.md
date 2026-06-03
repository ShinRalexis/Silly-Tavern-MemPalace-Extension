![MemPalace](Banner.jpg)

# ðŸ° MemPalace

> **Semantic long-term memory for SillyTavern characters.**  
> Beyond keywords â€” MemPalace gives your AI characters a real, persistent, searchable memory built on vector embeddings and a knowledge graph.

[![Version](https://img.shields.io/badge/version-3.10.0-blue)](#)
[![SillyTavern](https://img.shields.io/badge/SillyTavern-compatible-green)](#)
[![License](https://img.shields.io/badge/license-MIT-orange)](#license)

---

## âœ¨ What it does

SillyTavern's native memory is limited to a fixed context window. MemPalace replaces that with a full cognitive architecture:

- **Semantic RAG** â€” retrieves relevant memories based on meaning, not keywords
- **Knowledge Graph** â€” tracks facts, relationships and events as structured triples (Subject â†’ Predicate â†’ Object)
- **Memory Nucleus** â€” a permanent "core biography" always injected into the prompt
- **Lorebook ingestion** â€” teach entire lorebooks to a character once; they surface naturally during chat
- **AAAK compression** â€” compact memory encoding that saves up to 30Ã— token space
- **Timeline** â€” chronological view of all recorded events for a character

---

## ðŸ§  How memory is organized

Each character has a **Wing** (isolated memory space). Inside each wing, memories are stored in **Rooms**:

| Room | Content |
|---|---|
| `lore` | Lorebook entries, world facts, Oracle twists |
| `char` | Character responses, Judgement outcomes |
| `user` | User messages |
| `secret` | Hidden facts (known to character, never injected in prompt) |

---

## ðŸ“‹ Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (recent version)
- **MemPalace Server** running on `localhost:8052`  
  â†’ Install via **[Docker](#option-a--docker-recommended)** or **[Python direct](#option-b--python-direct)**

---

## ðŸš€ Installation

### Option A â€” Docker (recommended)

```bash
git clone https://github.com/ShinRalexis/MemPalace-Server
cd MemPalace-Server
docker compose up -d
```

The server starts on port `8052` and persists data in local volumes.

### Option B â€” Python direct

```bash
git clone https://github.com/ShinRalexis/MemPalace-Server
cd MemPalace-Server
pip install -r requirements.txt
python bridge.py
```

---

## ðŸ”Œ Install the SillyTavern Extension

**Quick install (clone directly into ST):**

```powershell
git clone https://github.com/ShinRalexis/MemPalace
cd MemPalace
.\install.ps1
```

**Or use the installer script** (handles path detection automatically):

```powershell
cd MemPlace
.\install.ps1
```

The installer detects SillyTavern automatically and asks for your MemPalace server path. Settings are saved to `paths.local.json` (not synced to git).

---

## ðŸ”„ Updating

```powershell
# From your MemPlace folder:
.\install.ps1 -Update
```

This pulls the latest extension files, copies them to ST, and optionally restarts the Docker container.

**Reconfigure paths:**
```powershell
.\install.ps1 -Configure
```

---

## âš™ï¸ Configuration

Once the extension is enabled in SillyTavern, configure it from the Extensions panel:

| Setting | Description |
|---|---|
| Memory Isolation | **Global** (shared across all chats) or **Isolated** (per chat session) |
| RAG Relevance Threshold | 0.0 = retrieve everything Â· 1.0 = strict matches only |
| RAG Budget | Max characters injected per generation (default: 2000) |
| AAAK Compression | Compact token encoding (enable for long sessions) |
| Auto-scan | Automatically sync new chat messages to memory |

---

## ðŸ“¥ Lorebook Ingestion

1. Open Extensions â†’ MemPalace â†’ **Lorebook Ingestion**
2. Select a lorebook from the dropdown
3. Click **Ingest Lore** (confirm twice)

Entries with `[NO-RAG]` in content or keys are skipped. All other entries are expanded and stored â€” `{{char}}` becomes the character's canonical name, `{{user}}` becomes `you`.

---

## ðŸ”¬ Integration with Silly Quantum

MemPalace integrates with the [Silly Quantum](https://github.com/ShinRalexis/SillyQuantum) extension via a shared bridge (`window.__sillybridge`):

- **Chaotic quantum state** (`111xxx`/`110xxx`) â†’ increases personal memory retrieval
- **Oracle twists** â†’ saved automatically to character's `lore` room
- **Judgement outcomes** â†’ saved automatically to character's `char` room

---

## ðŸ—ºï¸ Knowledge Browser

Access from the MemPalace panel:

- **Timeline** â€” chronological events for the current character
- **Entity Registry** â€” all known facts grouped by subject
- **Deep Scan** â€” full historical analysis of the chat
- **Synaptic Map** â€” interactive graph visualization (requires vis-network)

---

## ðŸ’¾ Backup & Restore

**Export** all memories (drawers + KG facts + diary) to a JSON file via the **Backup** button.

**Restore** from a backup JSON with the **Restore** button. Supports both v1 and v2.0 export formats.

---

## ðŸ“ Repository Structure

```
MemPlace/
â”œâ”€â”€ index.js          â€” Main extension logic
â”œâ”€â”€ manifest.json     â€” SillyTavern extension manifest
â”œâ”€â”€ style.css         â€” UI styles
â”œâ”€â”€ index.html        â€” Extension settings panel
â”œâ”€â”€ vis-network.min.js â€” Graph visualization library
â”œâ”€â”€ assets/           â€” Images and static resources
â”œâ”€â”€ install.ps1       â€” Windows installer / updater
â””â”€â”€ Icons/            â€” Extension icons
```

---

## ðŸ”’ Privacy

All memory data is stored **locally** on your machine:
- ChromaDB vectors: configurable path (default `D:/AI/MemPalace_Memories`)
- Knowledge Graph: SQLite, same location
- No data is sent to external services

---

## ðŸ“„ License

MIT License â€” see [LICENSE](LICENSE)

---

*Made by [ShinRalexis](https://github.com/ShinRalexis)*

