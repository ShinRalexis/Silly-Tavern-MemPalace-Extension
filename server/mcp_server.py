#!/usr/bin/env python3
"""
MemPalace MCP Server — read/write palace access for Claude Code
================================================================
Install: claude mcp add mempalace -- python -m mempalace.mcp_server

Tools (read):
  mempalace_status          — total drawers, wing/room breakdown
  mempalace_list_wings      — all wings with drawer counts
  mempalace_list_rooms      — rooms within a wing
  mempalace_get_taxonomy    — full wing → room → count tree
  mempalace_search          — semantic search, optional wing/room filter
  mempalace_check_duplicate — check if content already exists before filing

Tools (write):
  mempalace_add_drawer      — file verbatim content into a wing/room
  mempalace_delete_drawer   — remove a drawer by ID
"""

import os
import sys
import json
import logging
import hashlib
from datetime import datetime

# PATCHED: Rimossi i punti per evitare ImportError in ambiente Docker "flat"
from config import MempalaceConfig
from version import __version__
from searcher import search_memories, format_results_narrative
from palace_graph import traverse, find_tunnels, graph_stats
import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

from knowledge_graph import KnowledgeGraph

_config = MempalaceConfig()

# Embedding: di default all-MiniLM-L6-v2 via ONNX (incluso in chromadb, zero dipendenze).
# E' un modello INGLESE: su un archivio italiano pesa le parole in comune invece del
# significato, e una parafrasi corretta non trova nulla (misurato il 2026-08-08).
#
# Se questo palazzo ha il modello multilingue in <config>/models/multilingual-minilm/,
# si usa quello. La scelta dipende dalla PRESENZA DELLA CARTELLA e non da un flag
# globale perche' lo stesso codice puo' servire piu' palazzi, ognuno col suo config e i
# suoi dati: cosi' un palazzo senza quella cartella resta sul default, coi suoi vettori
# intatti, senza dover sapere nulla di tutto questo.
#
# ATTENZIONE: i vettori dei due modelli non sono confrontabili. Attivare il multilingue
# senza ri-indicizzare l'archivio (reindex_multilingual.py) rende la ricerca inservibile.
from embed_multilingual import embedding_for, soglia_duplicati

_EMBEDDING_FN = embedding_for(_config.config_dir)

# Scaldata a freddo: il modello si carica alla prima chiamata e con e5-base costa ~10
# secondi. Farlo qui significa pagarli all'avvio del container, che succede di rado,
# invece che sulla prima ricerca dell'utente. Dopo, ogni ricerca sta sotto i 200 ms.
try:
    _EMBEDDING_FN(["scaldata"])
except Exception as _e:  # un fallimento qui non deve impedire l'avvio del server
    logging.getLogger("mempalace_mcp").warning(f"[MemPalace] Scaldata embedding fallita: {_e}")
_kg_path = os.path.join(_config.palace_path, "knowledge_graph.sqlite3")
_kg = KnowledgeGraph(db_path=_kg_path)

# Le parole che non possono diventare nodi del grafo. Una sola fonte, condivisa fra
# chi scrive (l'estrattore) e chi ripulisce (wipe_noise): se le due liste divergono,
# la pulizia toglie oggi quello che l'estrattore rimette domani.
_RUMORE_KG = set(KnowledgeGraph.NOISE_ENTITIES) | {
    "these", "those", "when", "in", "on", "at", "by", "as", "to", "for", "with",
    "because", "if", "while", "of", "from", "into", "about", "over", "under",
}

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
logger = logging.getLogger("mempalace_mcp")

try:
    _stats = _kg.stats()
    logger.info(f"[MemPalace] KG STATS ON STARTUP: {_stats}")
except Exception as e:
    logger.error(f"[MemPalace] KG STATS ERROR: {e}")


_chroma_client = None


def _get_collection(create=False):
    """Return the ChromaDB collection, or None on failure."""
    global _chroma_client
    try:
        if _chroma_client is None:
            _chroma_client = chromadb.PersistentClient(path=_config.palace_path)
        
        if create:
            return _chroma_client.get_or_create_collection(_config.collection_name, embedding_function=_EMBEDDING_FN)
        return _chroma_client.get_collection(_config.collection_name, embedding_function=_EMBEDDING_FN)
    except Exception as e:
        logger.error(f"ChromaDB error: {e}")
        return None


def _no_palace():
    return {
        "error": "No palace found",
        "hint": "Run: mempalace init <dir> && mempalace mine <dir>",
    }


# ==================== READ TOOLS ====================


def tool_status(wing: str = None, room: str = None, wings: list = None, **_ignorati):
    col = _get_collection()
    if not col:
        return _no_palace()

    where = {}
    if wing and room:
        where = {"$and": [{"wing": wing}, {"room": room}]}
    elif wing:
        where = {"wing": wing}
    elif room:
        where = {"room": room}

    if where:
        try:
            res = col.get(where=where, include=[])
            count = len(res["ids"])
        except Exception:
            count = 0
    else:
        count = col.count()

    wings = {}
    rooms = {}
    weight_bytes = 0
    diary_count = 0
    campione_testi = []
    try:
        kwargs = {"include": ["metadatas", "documents"], "limit": 10000}
        if where:
            kwargs["where"] = where
        
        fetched = col.get(**kwargs)
        all_meta = fetched["metadatas"]
        all_docs = fetched.get("documents", [])

        for i, m in enumerate(all_meta):
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            wings[w] = wings.get(w, 0) + 1
            rooms[r] = rooms.get(r, 0) + 1
            
            # Calculate weight from the document if available
            if i < len(all_docs) and all_docs[i]:
                weight_bytes += len(all_docs[i].encode('utf-8'))
                # Campione per la misura AAAK: bastano poche decine di ricordi
                # veri per un rapporto attendibile, e comprimerli tutti a ogni
                # apertura del pannello costerebbe secondi per niente.
                if len(campione_testi) < 40 and r in ("char", "user"):
                    campione_testi.append(all_docs[i])

            if r == "diary":
                diary_count += 1
    except Exception:
        pass

    # Il diary viene salvato con la convenzione "wing_<nome>" (es: "Mary Jane" → "wing_mary_jane").
    # Se abbiamo filtrato per una wing specifica e non abbiamo trovato diary nella wing diretta,
    # cerchiamo anche nella wing prefissata per mostrare il dato corretto nell'UI.
    if wing and diary_count == 0:
        diary_wing = f"wing_{wing.lower().replace(' ', '_')}"
        if diary_wing != wing:
            try:
                diary_res = col.get(
                    where={"$and": [{"wing": diary_wing}, {"room": "diary"}]},
                    include=[]
                )
                diary_count = len(diary_res["ids"])
            except Exception:
                pass

    weight_kb = round(weight_bytes / 1024, 2)

    # Sort distributions for easy UI access
    sorted_wings = sorted(wings.items(), key=lambda x: x[1], reverse=True)[:10]
    sorted_rooms = sorted(rooms.items(), key=lambda x: x[1], reverse=True)[:10]

    try:
        # I numeri del grafo devono parlare dello STESSO contesto dei cassetti
        # appena contati: se si chiede lo stato di una wing, "KG Nodi" e "KG Triple"
        # sono quelli di quella wing. Senza closet (richiesta globale) restano i
        # totali dell'archivio, che e' il comportamento giusto per quella domanda.
        closets = [w for w in (wings or []) if w] or ([wing] if wing else [])
        # Le wing di lore non hanno fatti nel grafo: passarle non cambia i conti, ma
        # nemmeno disturba, quindi si inoltrano cosi' come arrivano.
        kg_stats = _kg.stats(wings=closets)
    except Exception as e:
        logger.error(f"[MemPalace] KG stats failed: {e}")
        kg_stats = {"entities": 0, "triples": 0, "current_facts": 0}

    return {
        "total_drawers": count,
        "count": count,
        "wings": wings,
        "rooms": rooms,
        "top_wings": sorted_wings,
        "top_rooms": sorted_rooms,
        "weight_bytes": weight_bytes,
        "weight_kb": weight_kb,
        "diary_entries": diary_count,
        "kg_entities": kg_stats["entities"],
        "kg_facts": kg_stats["triples"],
        "kg": kg_stats,
        "palace_path": _config.palace_path,
        "protocol": PALACE_PROTOCOL,
        "aaak_dialect": AAAK_SPEC,
        # Il pannello aveva da sempre un indicatore "AAAK savings" che non si e' mai
        # acceso, perche' `aaak_ratio` non lo calcolava nessuno. Ora e' una MISURA:
        # si comprime davvero un campione dei ricordi con Dialect.compress() e si
        # riporta il risparmio ottenuto. Non e' una stima e non e' il "30x" della
        # documentazione — e' quanto vale su questi ricordi qui.
        **_misura_aaak(campione_testi),
    }


def _misura_aaak(testi):
    """Quanto si risparmierebbe comprimendo questi ricordi in dialetto AAAK."""
    testi = [t for t in (testi or []) if t and len(t) > 40][:40]
    if not testi:
        return {}
    try:
        from dialect import Dialect
        d = Dialect()
        prima = sum(len(t) for t in testi)
        dopo = sum(len(d.compress(t) or "") for t in testi)
        if prima <= 0 or dopo <= 0:
            return {}
        return {
            "aaak_ratio": round(1 - (dopo / prima), 3),
            "aaak_sample": len(testi),
        }
    except Exception as e:
        logger.warning(f"[MemPalace] Misura AAAK non riuscita: {e}")
        return {}




# ── AAAK Dialect Spec ─────────────────────────────────────────────────────────

PALACE_PROTOCOL = """IMPORTANT: MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_status to load palace overview + AAAK spec.
2. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
3. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
4. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
5. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory."""

AAAK_SPEC = """AAAK is a compressed memory dialect that MemPalace uses for efficient storage.
It is designed to be readable by both humans and LLMs without decoding.

FORMAT:
  ENTITIES: 3-letter uppercase codes. ALC=Alice, JOR=Jordan, RIL=Riley, MAX=Max, BEN=Ben.
  EMOTIONS: *action markers* (e.g., *warm*, *fear*, *raw*, *bloom*). High-signal emotional cues.
  STRUCTURE: Pipe-separated fields. FAM: family | PROJ: projects | ⚠: warnings/reminders.
  DATES: ISO format (2026-03-31). COUNTS: Nx = N mentions (e.g., 570x).
  IMPORTANCE: ★ to ★★★★★ (1-5 scale).
  HALLS: hall_facts, hall_events, hall_discoveries, hall_preferences, hall_advice.
  WINGS: wing_user, wing_agent, wing_team, wing_code, wing_myproject, wing_hardware, wing_ue5, wing_ai_research.
  ROOMS: Hyphenated slugs representing named ideas (e.g., chromadb-setup, gpu-pricing).

EXAMPLE:
  FAM: ALC→♡JOR | 2D(kids): RIL(18,sports) MAX(11,chess+swimming) | BEN(contributor)

Read AAAK naturally: expand codes mentally, treat *markers* as emotional context.
When WRITING AAAK: use entity codes, mark emotions, keep structure tight."""


def tool_list_wings():
    col = _get_collection()
    if not col:
        return _no_palace()
    wings = {}
    try:
        all_meta = col.get(include=["metadatas"], limit=10000)["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            wings[w] = wings.get(w, 0) + 1
    except Exception:
        pass
    return {"wings": wings}


def tool_list_rooms(wing: str = None):
    col = _get_collection()
    if not col:
        return _no_palace()
    rooms = {}
    try:
        kwargs = {"include": ["metadatas"], "limit": 10000}
        if wing:
            kwargs["where"] = {"wing": wing}
        all_meta = col.get(**kwargs)["metadatas"]
        for m in all_meta:
            r = m.get("room", "unknown")
            rooms[r] = rooms.get(r, 0) + 1
    except Exception:
        pass
    return {"wing": wing or "all", "rooms": rooms}


def tool_get_taxonomy():
    col = _get_collection()
    if not col:
        return _no_palace()
    taxonomy = {}
    try:
        all_meta = col.get(include=["metadatas"], limit=10000)["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            if w not in taxonomy:
                taxonomy[w] = {}
            taxonomy[w][r] = taxonomy[w].get(r, 0) + 1
    except Exception:
        pass
    return {"taxonomy": taxonomy}


def tool_search(
    query: str,
    limit: int = 5,
    wing: str = None,
    room: str = None,
    wings: list = None,
    room_exclude=None,   # stringa o elenco di stanze
    **_ignorati,
):
    """
    Ricerca semantica.

    wings permette di cercare in piu' wing insieme (la lore di un mondo e i ricordi
    del personaggio stanno in wing separate). **_ignorati assorbe i parametri che il
    frontend manda e qui non esistono, tipo room_hint: senza, arriverebbe un
    TypeError e la fase morirebbe con un `null` che il chiamante scambia per
    "nessun risultato".
    """
    return search_memories(
        query,
        palace_path=_config.palace_path,
        wing=wing,
        wings=wings,
        room=room,
        room_exclude=room_exclude,
        n_results=limit,
    )


def tool_check_duplicate(content: str, threshold: float = None, wing: str = None):
    col = _get_collection()
    if not col:
        return _no_palace()
    # La soglia dipende dal modello di embedding: vedi soglia_duplicati(), tarata sui
    # dati. Passarla a mano resta possibile, ma il default non e' piu' un numero fisso.
    if threshold is None:
        threshold = soglia_duplicati(_config.config_dir)
    try:
        where = {"wing": wing} if wing else None
        # Si confronta un DOCUMENTO con altri DOCUMENTI, quindi si embedda col ramo
        # documenti. Usare query_texts passerebbe dal ramo ricerca, che con la famiglia
        # E5 antepone "query: " invece di "passage: ": un confronto asimmetrico fra due
        # cose che sono entrambe ricordi, con punteggi che non stanno sulla stessa scala
        # di quelli su cui la soglia e' tarata.
        results = col.query(
            query_embeddings=_EMBEDDING_FN([content]),
            n_results=5,
            where=where,
            include=["metadatas", "documents", "distances"],
        )
        duplicates = []
        if results["ids"] and results["ids"][0]:
            for i, drawer_id in enumerate(results["ids"][0]):
                dist = results["distances"][0][i]
                similarity = round(1 - dist, 3)
                if similarity >= threshold:
                    meta = results["metadatas"][0][i]
                    doc = results["documents"][0][i]
                    duplicates.append(
                        {
                            "id": drawer_id,
                            "wing": meta.get("wing", "?"),
                            "room": meta.get("room", "?"),
                            "similarity": similarity,
                            "content": doc[:200] + "..." if len(doc) > 200 else doc,
                        }
                    )
        return {
            "is_duplicate": len(duplicates) > 0,
            "matches": duplicates,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_get_aaak_spec():
    """Return the AAAK dialect specification."""
    return {"aaak_spec": AAAK_SPEC}


def tool_traverse_graph(start_room: str, max_hops: int = 2):
    """Walk the palace graph from a room. Find connected ideas across wings."""
    col = _get_collection()
    if not col:
        return _no_palace()
    return traverse(start_room, col=col, max_hops=max_hops)


def tool_find_tunnels(wing_a: str = None, wing_b: str = None):
    """Find rooms that bridge two wings: the hallways connecting domains."""
    col = _get_collection()
    if not col:
        return _no_palace()
    return find_tunnels(wing_a, wing_b, col=col)


def tool_graph_stats():
    """Palace graph overview: nodes, tunnels, edges, connectivity."""
    col = _get_collection()
    if not col:
        return _no_palace()
    return graph_stats(col=col)


def tool_list_drawers(wing: str = None, room: str = None, limit: int = 50):
    """List drawers (with content) in a wing or room."""
    col = _get_collection()
    if not col:
        return _no_palace()

    where = {}
    if wing and room:
        where = {"$and": [{"wing": wing}, {"room": room}]}
    elif wing:
        where = {"wing": wing}
    elif room:
        where = {"room": room}

    try:
        results = col.get(
            where=where if where else None,
            include=["documents", "metadatas"],
            limit=limit
        )
        drawers = []
        for drawer_id, doc, meta in zip(results["ids"], results["documents"], results["metadatas"]):
            m = meta or {}
            drawers.append({
                "id": drawer_id,
                "wing": m.get("wing"),
                "room": m.get("room"),
                "content": doc,
                "filed_at": m.get("filed_at"),
                "source_file": m.get("source_file", "")
            })
        return {"drawers": drawers, "count": len(drawers)}
    except Exception as e:
        return {"error": str(e)}


def tool_get_formatted_context(query: str, character: str = "Assistant", limit: int = 5, wing: str = None):
    """
    SillyTavern Optimized: Returns a single clean, narrative string containing
    semantic search results, KG facts, and the Cognitive Shield.
    """
    # 1. Semantic Search
    search_res = search_memories(
        query,
        palace_path=_config.palace_path,
        wing=wing,
        n_results=limit,
    )
    narrative_text = format_results_narrative(search_res, agent_name=character)

    # 2. KG Facts
    kg_res = tool_kg_query(entity=character, wing=wing)
    facts = kg_res.get("facts", [])
    if facts:
        fact_lines = ["\n[Structured Facts]:"]
        for f in facts[:10]:
            fact_lines.append(f"- {f.get('subject')} is related to {f.get('object')} via '{f.get('predicate')}'")
        narrative_text += "\n" + "\n".join(fact_lines)

    shield = (
        "\n\n"
        "--- DIRETTIVA NARRATIVA ED IMMERSIONE ---\n"
        "1. IMMERSIONE TOTALE: Parla esclusivamente come il personaggio. Fornisci una narrazione lunga, super fluida e descrittiva.\n"
        "2. NESSUN ARTEFATTO: È severamente vietato usare monologhi interni tra parentesi, tag come (Internal Thoughts), (Pensiero) o (End Reflection).\n"
        "3. NATURALEZZA: I ricordi forniti sono solo background implicito. Non referenziarli come memorie esterne o prompt di sistema.\n"
        "4. ESPRESSIONE: Mostra i sentimenti e i pensieri del personaggio attraverso le sue azioni e il dialogo, senza interrompere la narrazione con tag testuali."
    )
    
    return {"context": narrative_text + shield}


def tool_get_graph(character: str = None, wing: str = None, wings: list = None):
    """Return filtered nodes and edges for the specific character context or wing."""
    try:
        active_char = character.strip() if character and character.strip() else None
        active_wing = wing.strip() if wing and wing.strip() else None
        active_wings = [w.strip() for w in (wings or []) if w and w.strip()]
        logger.info(f"[MemPalace] Graph Request - Char: '{active_char}', Wing: '{active_wing}', Wings: {active_wings}")

        data = _kg.get_full_graph(character=active_char, wing=active_wing, wings=active_wings)
        node_count = len(data.get("nodes", []))
        logger.info(f"[MemPalace] Graph data fetched: {node_count} nodes, {len(data.get('edges', []))} edges")
        
        if active_char:
            logger.info(f"[MemPalace] Graph ISOLATED for: '{active_char}' ({node_count} nodes)")
        else:
            logger.info(f"[MemPalace] Graph GLOBAL access ({node_count} nodes)")
            
        return data
    except Exception as e:
        logger.error(f"[MemPalace] Graph tool error: {e}")
        return {"error": str(e), "nodes": [], "edges": []}


# ==================== WRITE TOOLS ====================


def tool_add_drawer(
    wing: str, room: str, content: str, source_file: str = None, added_by: str = "mcp",
    dup_threshold: float = None, **kwargs
):
    """File verbatim content into a wing/room. Checks for duplicates first.

    `dup_threshold` alza (o abbassa) la soglia oltre la quale due testi sono
    considerati lo stesso ricordo, SOLO per questa scrittura.

    Serve allo spezzettamento: i pezzi di uno stesso ricordo si sovrappongono per
    non tagliare una frase a meta', e due pezzi contigui arrivano a somigliarsi
    0.96, cioe' sopra la soglia normale. Senza questa leva il secondo pezzo veniva
    rifiutato come duplicato del primo e la coda del ricordo non entrava mai in
    archivio: esattamente il guasto che lo spezzettamento doveva risolvere.
    Chi scrive a pezzi controlla il duplicato UNA VOLTA sul documento intero e poi
    passa una soglia quasi-uno qui, cosi' resta bloccato solo il testo identico.
    Default None: chi non lo passa si comporta esattamente come prima.
    """
    col = _get_collection(create=True)
    if not col:
        return _no_palace()

    # Duplicate check (filtered by wing)
    # Nessuna soglia a mano: la decide soglia_duplicati() in base al modello attivo.
    dup = tool_check_duplicate(content, threshold=dup_threshold, wing=wing)
    if dup.get("is_duplicate"):
        return {
            "success": False,
            "reason": "duplicate",
            "matches": dup["matches"],
        }

    drawer_id = f"drawer_{wing}_{room}_{hashlib.md5((content[:100] + datetime.now().isoformat()).encode()).hexdigest()[:16]}"

    try:
        col.add(
            ids=[drawer_id],
            documents=[content],
            metadatas=[
                {
                    "wing": wing,
                    "room": room,
                    "source_file": source_file or "",
                    "chunk_index": 0,
                    "added_by": added_by,
                    "filed_at": datetime.now().isoformat(),
                    **kwargs
                }
            ],
        )
        logger.info(f"Filed drawer: {drawer_id} → {wing}/{room}")
        return {"success": True, "drawer_id": drawer_id, "wing": wing, "room": room}
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_delete_drawer(drawer_id: str):
    """Delete a single drawer by ID."""
    col = _get_collection()
    if not col:
        return _no_palace()
    existing = col.get(ids=[drawer_id])
    if not existing["ids"]:
        return {"success": False, "error": f"Drawer not found: {drawer_id}"}
    try:
        col.delete(ids=[drawer_id])
        logger.info(f"Deleted drawer: {drawer_id}")
        return {"success": True, "drawer_id": drawer_id}
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_wipe(wing: str):
    """Delete ALL drawers belonging to a wing. Irreversible."""
    col = _get_collection()
    if not col:
        return _no_palace()
    try:
        # 1. Wipe vector memories (ChromaDB)
        col.delete(where={"wing": wing})
        
        # 3. Wipe graph facts (SQLite)
        # Se siamo in Isolata, passiamo il wing. Se siamo in Globale, passiamo il nome del personaggio per pulire tutto.
        # N.B. In index.js wingId per Globale è il nome pulito del personaggio.
        _kg.wipe_closet(source_closet=wing, entity_name=wing if "chat_" not in wing else None)
        
        logger.info(f"Wiped wing and KG for: {wing}")
        return {"success": True, "wing": wing}
    except Exception as e:
        logger.error(f"Wipe failed for {wing}: {e}")
        return {"success": False, "error": str(e)}


# ==================== KNOWLEDGE GRAPH ====================


def tool_kg_query(entity: str = None, as_of: str = None, direction: str = "both", wing: str = None):
    """Query the knowledge graph for relationships, prioritizing the wing/context if provided."""
    results = []
    ent = entity.strip() if entity and entity.strip() else None
    logger.info(f"[MemPalace] Registry Request - Entity: '{ent}', Wing: '{wing}'")
    
    if wing:
        # If we have a wing, we fetch all facts from that context
        results = _kg.query_closet(wing)
        logger.info(f"[MemPalace] Closet Query for '{wing}' returned {len(results)} items")
        # If an entity was specified, filter the wing results by that entity.
        # Il confronto appiattisce trattini e spazi: chi chiama parte dal nome della
        # wing ("Mary_Jane") mentre nel grafo l'entita' e' scritta come compare nel
        # testo ("Mary-Jane"), e un confronto alla lettera scartava tutti e 67 i fatti
        # del personaggio restituendo zero senza un errore.
        if ent:
            def _piatto(x):
                return str(x or "").lower().replace("-", "_").replace(" ", "_")
            bersaglio = _piatto(ent)
            results = [
                f for f in results
                if _piatto(f["subject"]) == bersaglio or _piatto(f["object"]) == bersaglio
            ]
            logger.info(f"[MemPalace] Filtered by character '{ent}': {len(results)} items remaining")
    elif ent:
        # Global search for the entity
        results = _kg.query_entity(ent, as_of=as_of, direction=direction)
        
    return {"entity": ent or "all", "wing": wing, "as_of": as_of, "facts": results, "count": len(results)}


def tool_kg_neighbors(entity: str, depth: int = 2, wing: str = None):
    """
    Query relationships for an entity and its social network (friends of friends).

    wing va passato SEMPRE quando la rete sociale serve a un personaggio: senza, la
    traversata attraversa un grafo condiviso da tutti e riporta indietro i fatti di
    altri personaggi. Resta facoltativo solo per gli usi da strumento diagnostico,
    dove si vuole davvero guardare tutto il grafo.
    """
    results = _kg.query_neighbors(entity, depth=depth, source_closet=wing)
    return {"entity": entity, "depth": depth, "wing": wing, "facts": results, "count": len(results)}


def tool_kg_add(
    subject: str, predicate: str, object: str, valid_from: str = None,
    source_closet: str = None, wing: str = None, supersede: bool = None,
    source_file: str = None, **_ignorati
):
    """
    Add a relationship to the knowledge graph.

    `wing` e' un sinonimo di `source_closet`: tutto il resto dell'API chiama quel
    campo "wing" e chi scrive dal frontend si aspetta di poter usare lo stesso nome.
    `supersede` chiude i fatti precedenti incompatibili; se non specificato lo decide
    il predicato (vedi PREDICATI_ESCLUSIVI).

    `source_file` era gia' accettato da add_triple ma qui finiva dentro `**_ignorati`
    e veniva buttato via in silenzio. Serve: e' con quel marcatore (`lorebook:<Libro>`)
    che tool_kg_timeline tiene la lore FUORI dalla Timeline, che deve mostrare eventi
    e non schede di mondo. Senza, i fatti estratti da un lorebook col modello
    finivano tutti in Timeline con la data del giorno dell'ingestione.
    Parametro facoltativo con default None: chi non lo passa si comporta come prima.
    """
    closet = source_closet or wing
    triple_id = _kg.add_triple(
        subject, predicate, object, valid_from=valid_from,
        source_closet=closet, source_file=source_file, supersede=supersede
    )
    return {"success": True, "triple_id": triple_id, "wing": closet,
            "fact": f"{subject} → {predicate} → {object}"}


def tool_kg_invalidate(subject: str, predicate: str, object: str, ended: str = None,
                       wing: str = None, source_closet: str = None, **_ignorati):
    """Mark a fact as no longer true (set end date). `wing` lo limita a un personaggio."""
    closet = wing or source_closet
    chiusi = _kg.invalidate(subject, predicate, object, ended=ended, source_closet=closet)
    return {
        "success": True,
        "fact": f"{subject} → {predicate} → {object}",
        "ended": ended or "today",
        "wing": closet,
        "closed": chiusi,
    }


def tool_kg_timeline(entity: str = None, wing: str = None):
    """Get chronological timeline of facts, optionally filtered by entity and/or wing."""
    ent = entity.strip() if entity and entity.strip() else None
    wng = wing.strip() if wing and wing.strip() else None
    
    results = _kg.timeline(entity_name=ent, source_closet=wng)
    
    # Filter: remove facts that explicitly come from lorebooks or background knowledge
    # to keep the timeline focused on actual events.
    filtered_results = [
        f for f in results 
        if not (f.get("source_file") and "lorebook" in f["source_file"].lower())
        and not (f.get("source_file") and "lore_" in f["source_file"].lower())
        and not (f.get("source_file") and "lore:" in f["source_file"].lower())
    ]
    
    return {"entity": ent or "all", "wing": wng or "global", "timeline": filtered_results, "count": len(filtered_results)}


def guess_entity_type(name: str) -> str:
    """Heuristic to guess entity type from name (matches JS logic)."""
    n = name.lower()
    persons = ['ai ', 'user', 'character', 'persona', 'man', 'woman', 'girl', 'boy', 'friend', 'enemy', 'boss', 'king', 'queen', 'ragazzo', 'ragazza', 'uomo', 'donna', 'amico', 'nemico', 're ', 'regina', 'padre', 'madre', 'figlio', 'figlia', 'genitore', 'yota', 'moteuchi', 'rolek', 'iori', 'sister', 'sorella', 'family']
    places = ['room', 'house', 'city', 'place', 'area', 'zone', 'castle', 'park', 'building', 'world', 'storia', 'valle', 'torre', 'dungeon', 'forest', 'locanda', 'citt', 'casa', 'stanza', 'tempio', 'mappa', 'map', 'japan', 'gokuraku']
    objs = ['item', 'thing', 'sword', 'gun', 'book', 'key', 'artifact', 'relic', 'box', 'money', 'potion', 'tool', 'spada', 'chiave', 'scatola', 'libro', 'moneta', 'arma', 'oggetto', 'steel', 'dress', 'videotape', 'vcr', 'tape']
    events = ['battle', 'meeting', 'event', 'trip', 'journey', 'fight', 'death', 'birth', 'conversazione', 'avventura', 'incontro', 'stance', 'technique', 'moves', 'impact', 'combat', 'gesto', 'movimento', 'scansione', 'scan', 'heartbreak', 'sacrifice', 'attack', 'defense']
    concepts = ['love', 'hate', 'idea', 'plan', 'secret', 'dream', 'hope', 'fear', 'thought', 'plan', 'consapevolezza', 'verit', 'menzogna', 'question', 'presence', 'strength', 'balance', 'spirit', 'chi ', 'anomaly', 'sacrifice', 'authentic', 'transparency', 'emotion', 'psychology']
    sensations = ['feel', 'smell', 'touch', 'taste', 'sound', 'cold', 'hot', 'warm', 'pain', 'pleasure', 'sensazione', 'sentire', 'freddo', 'caldo', 'dolore', 'piacere', 'brivido', 'vibrazione']
    feelings = ['happy', 'sad', 'angry', 'afraid', 'surprised', 'disgusted', 'lonely', 'excited', 'triste', 'felice', 'arrabbiato', 'paura', 'sorpreso', 'solitudine', 'eccitato']
    
    # Argomenti specifici richiesti
    if any(k in n for k in ['dream', 'sogno', 'nightmare']): return 'dream'
    if any(k in n for k in ['threat', 'danger', 'risk', 'pericolo', 'minaccia']): return 'threat'
    if any(k in n for k in ['hope', 'wish', 'desire', 'speranza', 'desiderio']): return 'hope'
    if any(k in n for k in ['music', 'song', 'soundtrack', 'musica', 'canzone']): return 'music'
    if any(k in n for k in ['money', 'gold', 'price', 'finanza', 'soldi', 'oro']): return 'money'
    
    if any(k in n for k in persons): return 'person'
    if any(k in n for k in places): return 'place'
    if any(k in n for k in sensations): return 'sensation'
    if any(k in n for k in feelings): return 'feeling'
    if any(k in n for k in objs): return 'object'
    if any(k in n for k in events): return 'event'
    if any(k in n for k in concepts): return 'concept'
    return 'unknown'



def tool_kg_normalize():
    """Nuclear Cleanup: Truncate long entities and re-classify them."""
    import sqlite3
    import re  # fix: re was used below but never imported here
    try:
        conn = _kg._conn()
        conn.row_factory = sqlite3.Row
        
        # Normalize Entry Names
        entities = conn.execute("SELECT id, name, type FROM entities").fetchall()
        updates = 0
        for ent in entities:
            name = ent["name"]
            # Atomic Cleanup: remove filler and truncate
            new_name = re.sub(r'^(a|an|the|una?|il|lo|la|some|any|this|that|your|my)\s+', '', name, flags=re.I)
            new_name = re.sub(r'\s+(is|was|were|remains|seems|feels|looks|became)\s+.*', '', new_name, flags=re.I)
            new_name = new_name.strip(".,!?;: ")
            if len(new_name) > 35: new_name = new_name[:32] + "..."
            
            # Re-guess type
            new_type = guess_entity_type(new_name)
            if new_type == 'unknown' and ent["type"] != 'unknown':
                new_type = ent["type"] # preserve if already known
            
            if new_name != name or new_type != ent["type"]:
                conn.execute("UPDATE entities SET name = ?, type = ? WHERE id = ?", (new_name, new_type, ent["id"]))
                updates += 1
        
        conn.commit()
        conn.close()
        return {"success": True, "updated_entities": updates}
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_kg_stats():
    """Knowledge graph overview: entities, triples, relationship types."""
    return _kg.stats()


def tool_extract_facts(text: str, character: str = None, save: bool = True, valid_from: str = None, source_file: str = None):
    """
    Extract entity-relationship triples from a plain text message using
    heuristic NLP patterns. Optionally saves them directly to the KG.
    Returns the list of discovered facts.
    """
    import re

    # Strictly match 1 to 4 Capitalized words, supporting accents (e.g. 'Mary-Jane', 'Papà')
    #
    # Il trattino sta in FONDO alla classe di caratteri, e non e' un dettaglio di
    # stile. Scritto come prima — [a-zA-Z\.\'-À-ÖØ-öø-ÿ] — quel trattino non era un
    # trattino ma un INTERVALLO da ' (0x27) a À (0xC0): ci finivano dentro virgole,
    # parentesi quadre, due punti e le cifre. Il "nome proprio" poteva quindi
    # inghiottire mezza riga di lorebook ("Nome, Luogo]") e il grafo si riempiva
    # di entita' che nessuno avrebbe mai potuto interrogare.
    LETTERE = r"[a-zA-ZÀ-ÖØ-öø-ÿ.'\-]"
    SUBJ_REGEX = rf"([A-ZÀ-ÖØ-Þ]{LETTERE}+(?:\s+[A-ZÀ-ÖØ-Þ]{LETTERE}+){{0,3}})"

    # Predicate pattern map: (regex pattern, canonical predicate, subj_group, obj_group)
    #
    # NOTA — il pattern `described_as` e' stato RIMOSSO, non commentato per pigrizia.
    # Era `SUBJ , (a|an|the|...)? testo` e prendeva qualunque parola maiuscola seguita
    # da una virgola: siccome ogni frase di narrativa comincia con "However,", "Well,",
    # "Suddenly,", produceva da sola il 68% delle triple dell'archivio (973 su 1429),
    # tutte con soggetti che non sono entita'. Peggio: nel gruppo degli articoli
    # mancava il confine di parola, quindi su "However, their affection" l'alternativa
    # `the` mordeva dentro "their" e l'oggetto salvato diventava "ir affection".
    # Un estrattore che sbaglia 2 fatti su 3 e' peggio di un estrattore che tace,
    # perche' quei fatti finiscono nel prompt come se fossero memoria del personaggio.
    PATTERNS = [
        # "X is a/an Y"
        (rf"\b{SUBJ_REGEX}\s+(?:is a|is an|is|are|were|was|è una?|è|sono)\s+([^.\n,]+?)(?=[.\n,]|$)","is_a", 1, 2),
        # "X has Y"
        (rf"\b{SUBJ_REGEX}\s+(?:has|ha|have|hanno)\s+(?:an?\s+)?([^.\n,]+?)(?=[.\n,]|$)","has", 1, 2),
        # "X loves Y"
        (rf"\b{SUBJ_REGEX}\s+(?:loves?|ama)\s+([^.\n,]+?)(?=[.\n,]|$)","loves", 1, 2),
        # "X lives in Y"
        (rf"\b{SUBJ_REGEX}\s+(?:lives? in|vive a|abita a)\s+([^.\n,]+?)(?=[.\n,]|$)","lives_in", 1, 2),
        # "X works at Y"
        (rf"\b{SUBJ_REGEX}\s+(?:works? at|lavora a|lavora per)\s+([^.\n,]+?)(?=[.\n,]|$)","works_at", 1, 2),
        # "X likes Y"
        (rf"\b{SUBJ_REGEX}\s+(?:likes?|piace|enjoys?)\s+([^.\n,]+?)(?=[.\n,]|$)","likes", 1, 2),
    ]

    logger.info(f"KG Extraction started for text: '{text[:50]}...' [char={character}]")
    discovered = []
    seen = set()

    for pattern, predicate, subj_g, obj_g in PATTERNS:
        # DO NOT use IGNORECASE here as the patterns rely on [A-Z] for proper entities
        for m in re.finditer(pattern, text, re.MULTILINE):
            try:
                subj = m.group(subj_g).strip()
                obj = m.group(obj_g).strip()

                # Il soggetto va ridotto all'entita' NUDA prima di qualunque altra
                # cosa. Senza questo passaggio il grafo si riempie di nodi-artefatto
                # ("To Mary-Jane", "For Mary-Jane, Peter", "Key: Nome") che sono
                # varianti dello stesso personaggio ma id diversi: il personaggio
                # non esiste come nodo suo e la sua rete sociale e' irraggiungibile,
                # 69 fatti in archivio e zero recuperabili. "Key:" in particolare
                # arriva dall'ingestione lore, che antepone "[Key: parole chiave]"
                # al testo di ogni voce del lorebook.
                # Il punto e' ammesso dentro il nome (serve per "Dr.", "St."), ma un
                # punto seguito da spazio e' la fine di una frase, non parte del nome:
                # senza questo taglio "New York. Testchar loves her father" produceva
                # il soggetto "New York. Testchar", un'entita' che non esiste e che
                # nessuna interrogazione potra' mai incontrare. Si tiene l'ULTIMO
                # pezzo, che e' quello che regge davvero il verbo.
                subj = re.split(r'\.\s+', subj)[-1].strip()
                subj = re.sub(r'^\s*\[?\s*key\s*:\s*', '', subj, flags=re.I)
                subj = re.sub(r'^(to|for|from|with|here|there|and|but|so|of|in|on|at|by)\b\s+', '', subj, flags=re.I)
                subj = subj.split(",")[0].strip(" .:;-")
                if not subj:
                    continue
                
                # Validation: avoid common noise and long fragments
                # Una lista sola, condivisa con KnowledgeGraph.wipe_noise(): quello che
                # l'estrattore rifiuta di scrivere e quello che la pulizia cancella
                # devono essere la stessa cosa, altrimenti si ripulisce a mano un grafo
                # che si risporca da solo al messaggio dopo.
                blacklist = _RUMORE_KG
                if len(subj) < 2 or len(obj) < 2 or len(obj) > 35 or len(subj) > 30:
                    continue
                if subj.lower() in blacklist or obj.lower() in blacklist:
                    continue

                # Cleanup: remove trailing punctuation or articles
                # Atomic Cleanup: shorten phrases and remove filler
                # \b in coda agli articoli: senza, `the` morde dentro "their" e
                # l'oggetto viene troncato a meta' parola ("ir affection").
                obj = re.sub(r'^(a|an|the|una?|il|lo|la|some|any|this|that|your|my)\b\s+', '', obj, flags=re.I)
                obj = re.sub(r'\s+(is|was|were|remains|seems|feels|looks|became)\s+.*', '', obj, flags=re.I)
                obj = obj.strip(".,!?;: ")
                if len(obj) < 2: continue
                # Ricontrollo DOPO la pulizia: "the However" entrava con l'articolo
                # davanti e superava il primo controllo, che vedeva una stringa diversa.
                if obj.lower() in blacklist:
                    continue

                key = (subj.lower(), predicate, obj.lower())
                if key in seen:
                    continue
                seen.add(key)
                
                fact = {
                    "subject": subj,
                    "predicate": predicate,
                    "object": obj,
                }
                discovered.append(fact)
                logger.info(f"KG Match Found: {subj} --[{predicate}]--> {obj}")
            except (IndexError, AttributeError):
                continue

    # If character context provided, also link discovered entities to character
    if character and save and discovered:
        logger.info(f"Saving {len(discovered)} facts to KG for {character}")
        for fact in discovered:
            try:
                sub_type = guess_entity_type(fact["subject"])
                obj_type = guess_entity_type(fact["object"])
                
                # Special case: if the character is the subject/object, it's an agent
                if character and fact["subject"].lower() == character.lower(): sub_type = 'agent'
                if character and fact["object"].lower() == character.lower(): obj_type = 'agent'

                # supersede=None -> lo decide il predicato. Cosi' "Mary-Jane lives_in
                # New York" chiude da sola "Mary-Jane lives_in Boston" quando la
                # storia la fa trasferire, senza che nessuno debba accorgersene.
                _kg.add_triple(
                    fact["subject"], fact["predicate"], fact["object"],
                    source_closet=character,
                    source_file=source_file,
                    valid_from=valid_from,
                    subject_type=sub_type,
                    object_type=obj_type,
                    supersede=None
                )
            except Exception as e:
                logger.error(f"KG persistence failed for {fact}: {e}")

    return {
        "character": character or "unknown",
        "facts_found": len(discovered),
        "saved": save,
        "facts": discovered
    }


# ==================== AGENT DIARY ====================


def tool_diary_write(agent_name: str = None, entry: str = "", topic: str = "general", wing: str = None, **kwargs):
    """
    Write a diary entry for this agent. Each agent gets its own wing
    with a diary room. Entries are timestamped and accumulate over time.
    """
    if not wing and agent_name:
        wing = f"wing_{agent_name.lower().replace(' ', '_')}"
    
    if not wing:
        return {"success": False, "error": "No wing or agent_name provided"}
        
    room = "diary"
    col = _get_collection(create=True)
    if not col:
        return _no_palace()

    now = datetime.now()
    entry_id = f"diary_{wing}_{now.strftime('%Y%m%d_%H%M%S')}_{hashlib.md5(entry[:50].encode()).hexdigest()[:8]}"

    try:
        # Pulisce i vecchi "Nuclei" per evitare doppioni brutti e inutili (sovrascrittura)
        col.delete(where={"$and": [{"wing": wing}, {"room": room}]})
        
        col.add(
            ids=[entry_id],
            documents=[entry],
            metadatas=[
                {
                    "wing": wing,
                    "room": room,
                    "hall": "hall_diary",
                    "topic": topic,
                    "type": "diary_entry",
                    "agent": agent_name,
                    "filed_at": now.isoformat(),
                    "date": now.strftime("%Y-%m-%d"),
                }
            ],
        )
        logger.info(f"Diary entry: {entry_id} → {wing}/diary/{topic}")
        return {
            "success": True,
            "entry_id": entry_id,
            "agent": agent_name,
            "topic": topic,
            "timestamp": now.isoformat(),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def tool_diary_read(agent_name: str = None, last_n: int = 10, wing: str = None):
    """
    Read an agent's recent diary entries. Returns the last N entries.
    """
    if not wing and agent_name:
        wing = f"wing_{agent_name.lower().replace(' ', '_')}"
    
    if not wing:
        return {"success": False, "error": "No wing or agent_name provided"}
        
    col = _get_collection()
    if not col:
        return _no_palace()

    try:
        results = col.get(
            where={"$and": [{"wing": wing}, {"room": "diary"}]},
            include=["documents", "metadatas"],
            limit=10000,
        )

        if not results["ids"]:
            return {"agent": agent_name, "entries": [], "message": "No diary entries yet."}

        entries = []
        for doc, meta in zip(results["documents"], results["metadatas"]):
            entries.append(
                {
                    "date": meta.get("date", ""),
                    "timestamp": meta.get("filed_at", ""),
                    "topic": meta.get("topic", ""),
                    "content": doc,
                }
            )

        entries.sort(key=lambda x: x["timestamp"], reverse=True)
        entries = entries[:last_n]

        # Consolidated content for the UI
        consolidated = "\n".join([e["content"] for e in reversed(entries)])

        return {
            "agent": agent_name,
            "wing": wing,
            "entries": entries,
            "content": consolidated,
            "total": len(results["ids"]),
            "showing": len(entries),
        }
    except Exception as e:
        return {"error": str(e)}


# ==================== MCP PROTOCOL ====================

TOOLS = {
    "mempalace_debug_paths": {
        "description": "Returns internal server paths for debugging",
        "input_schema": {"type": "object", "properties": {}},
        "handler": lambda: {
            "palace_path": _config.palace_path,
            "kg_path": _kg_path,
            "db_exists": os.path.exists(_kg_path),
            "db_size": os.path.getsize(_kg_path) if os.path.exists(_kg_path) else 0,
            "cwd": os.getcwd()
        }
    },
    "mempalace_kg_normalize": {"description": "Atomic cleanup of long entities", "input_schema": {"type": "object", "properties": {}}, "handler": tool_kg_normalize},
    "mempalace_status": {
        "description": "Palace overview: total drawers, wing and room counts",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing": {"type": "string", "description": "Filter by wing (optional)"},
                "room": {"type": "string", "description": "Filter by room (optional)"},
            },
        },
        "handler": tool_status,
    },
    "mempalace_list_wings": {
        "description": "List all wings with drawer counts",
        "input_schema": {"type": "object", "properties": {}},
        "handler": tool_list_wings,
    },
    "mempalace_list_rooms": {
        "description": "List rooms within a wing (or all rooms if no wing given)",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing": {"type": "string", "description": "Wing to list rooms for (optional)"},
            },
        },
        "handler": tool_list_rooms,
    },
    "mempalace_get_taxonomy": {
        "description": "Full taxonomy: wing → room → drawer count",
        "input_schema": {"type": "object", "properties": {}},
        "handler": tool_get_taxonomy,
    },
    "mempalace_get_aaak_spec": {
        "description": "Get the AAAK dialect specification. Call this if you need to read or write AAAK-compressed memories.",
        "input_schema": {"type": "object", "properties": {}},
        "handler": tool_get_aaak_spec,
    },
    "mempalace_kg_query": {
        "description": "Query the knowledge graph for relationships.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entity": {"type": "string", "description": "Entity to query (optional if wing provided)"},
                "wing": {"type": "string", "description": "Include all facts from this wing (optional)"},
                "as_of": {"type": "string", "description": "Date filter (YYYY-MM-DD, optional)"},
                "direction": {"type": "string", "description": "outgoing, incoming, or both"},
            },
        },
        "handler": tool_kg_query,
    },
    "mempalace_get_formatted_context": {
        "description": "Returns a clean, narrative context block for SillyTavern (Search + KG + Shield).",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "character": {"type": "string", "description": "Active character name"},
                "wing": {"type": "string", "description": "Optional wing filter"},
                "limit": {"type": "integer", "description": "Max fragments"},
            },
            "required": ["query"],
        },
        "handler": tool_get_formatted_context,
    },
    "mempalace_kg_neighbors": {
        "description": "Query relationships for an entity and its social network (friends of friends).",
        "input_schema": {
            "type": "object",
            "properties": {
                "entity": {"type": "string", "description": "Primary entity"},
                "depth": {"type": "integer", "description": "Graph depth (default 2)"},
                "wing": {"type": "string", "description": "Limita la traversata ai fatti di questa wing. Ometterlo significa cercare in TUTTO il grafo, wing di altri personaggi comprese."},
            },
            "required": ["entity"],
        },
        "handler": tool_kg_neighbors,
    },
    "mempalace_kg_add": {
        "description": "Add a fact to the knowledge graph.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "predicate": {"type": "string"},
                "object": {"type": "string"},
                "valid_from": {"type": "string"},
                "source_closet": {"type": "string"},
                "wing": {"type": "string", "description": "Sinonimo di source_closet"},
                "source_file": {"type": "string", "description": "Provenienza, es. 'lorebook:<Libro>': tiene il fatto fuori dalla Timeline"},
            },
            "required": ["subject", "predicate", "object"],
        },
        "handler": tool_kg_add,
    },
    "mempalace_kg_invalidate": {
        "description": "Mark a fact as no longer true.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "predicate": {"type": "string"},
                "object": {"type": "string"},
                "ended": {"type": "string"},
            },
            "required": ["subject", "predicate", "object"],
        },
        "handler": tool_kg_invalidate,
    },
    "mempalace_kg_timeline": {
        "description": "Chronological timeline of facts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entity": {"type": "string"},
                "wing": {"type": "string", "description": "Filtered by wing/session (optional)"},
            },
        },
        "handler": tool_kg_timeline,
    },
    "mempalace_kg_stats": {
        "description": "Knowledge graph overview.",
        "input_schema": {"type": "object", "properties": {}},
        "handler": tool_kg_stats,
    },
    "mempalace_traverse": {
        "description": "Walk the palace graph from a room.",
        "input_schema": {
            "type": "object",
            "properties": {
                "start_room": {"type": "string"},
                "max_hops": {"type": "integer"},
            },
            "required": ["start_room"],
        },
        "handler": tool_traverse_graph,
    },
    "mempalace_find_tunnels": {
        "description": "Find rooms that bridge two wings.",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing_a": {"type": "string"},
                "wing_b": {"type": "string"},
            },
        },
        "handler": tool_find_tunnels,
    },
    "mempalace_graph_stats": {
        "description": "Palace graph overview.",
        "input_schema": {"type": "object", "properties": {}},
        "handler": tool_graph_stats,
    },
    "mempalace_search": {
        "description": "Semantic search.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
                "wing": {"type": "string"},
                "room": {"type": "string"},
            },
            "required": ["query"],
        },
        "handler": tool_search,
    },
    "mempalace_check_duplicate": {
        "description": "Check if content already exists.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "threshold": {"type": "number"},
                "wing": {"type": "string", "description": "Wing to check for duplicates in (optional)"},
            },
            "required": ["content"],
        },
        "handler": tool_check_duplicate,
    },
    "mempalace_add_drawer": {
        "description": "File verbatim content into the palace.",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing": {"type": "string"},
                "room": {"type": "string"},
                "content": {"type": "string"},
                "source_file": {"type": "string"},
                "added_by": {"type": "string"},
            },
            "dup_threshold": {"type": "number", "description": "Soglia duplicati solo per questa scrittura (per i pezzi di un ricordo spezzato)"},
                "required": ["wing", "room", "content"],
        },
        "handler": tool_add_drawer,
    },
    "mempalace_delete_drawer": {
        "description": "Delete a drawer by ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "drawer_id": {"type": "string"},
            },
            "required": ["drawer_id"],
        },
        "handler": tool_delete_drawer,
    },
    "diary_write": {
        "description": "Write a permanent memory/diary entry for this agent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string"},
                "wing": {"type": "string"},
                "entry": {"type": "string"},
                "topic": {"type": "string"},
            },
            "required": ["entry"],
        },
        "handler": tool_diary_write,
    },
    "mempalace_diary_write": {
        "description": "Alias for diary_write",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string"},
                "wing": {"type": "string"},
                "entry": {"type": "string"},
                "topic": {"type": "string"},
            },
            "required": ["entry"],
        },
        "handler": tool_diary_write,
    },
    "diary_read": {
        "description": "Read an agent's persistent memories.",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string"},
                "wing": {"type": "string"},
                "last_n": {"type": "integer"},
            },
        },
        "handler": tool_diary_read,
    },
    "mempalace_diary_read": {
        "description": "Alias for diary_read",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {"type": "string"},
                "wing": {"type": "string"},
                "last_n": {"type": "integer"},
            },
        },
        "handler": tool_diary_read,
    },
    "mempalace_list_drawers": {
        "description": "List drawers (with content) for debugging/inspection.",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing": {"type": "string"},
                "room": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
        "handler": tool_list_drawers,
    },
    "mempalace_wipe": {
        "description": "Wipe all memories for a specific wing/character. Irreversible.",
        "input_schema": {
            "type": "object",
            "properties": {
                "wing": {"type": "string", "description": "Wing to wipe"},
            },
            "required": ["wing"],
        },
        "handler": tool_wipe,
    },
    "mempalace_extract_facts": {
        "description": "Extract entity-relationship triples (S-P-O) from a text message using NLP patterns, and optionally save them to the KG.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The message text to analyze"},
                "character": {"type": "string", "description": "The character wing context (e.g. 'Mary Jane')"},
                "save": {"type": "boolean", "description": "If true, saves discovered facts to KG automatically"},
                "valid_from": {"type": "string", "description": "Optional ISO date (2026-03-31) representing when the fact started being true"},
                "source_file": {"type": "string", "description": "Optional source file name"},
            },
            "required": ["text"],
        },
        "handler": tool_extract_facts,
    },
    "mempalace_get_graph": {
        "description": "Export the full Knowledge Graph for visualization. Can be filtered by character.",
        "input_schema": {
            "type": "object", 
            "properties": {
                "character": {"type": "string", "description": "Character name to filter by (optional)"},
                "wing": {"type": "string", "description": "Wing context ID to fetch (optional)"}
            }
        },
        "handler": tool_get_graph,
    },
    "mempalace_kg_purge_noise": {
        "description": "Deletes common pronouns and noise words from the graph.",
        "input_schema": {"type": "object", "properties": {}},
        "handler": lambda: _kg.wipe_noise()
    }
}
print(f"[MemPalace] TOOLS REGISTERED: {list(TOOLS.keys())}")


def handle_request(request):
    method = request.get("method", "")
    params = request.get("params", {})
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mempalace", "version": __version__},
            },
        }
    elif method == "notifications/initialized":
        return None
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {"name": n, "description": t["description"], "inputSchema": t["input_schema"]}
                    for n, t in TOOLS.items()
                ]
            },
        }
    elif method == "tools/call":
        tool_name = params.get("name")
        tool_args = params.get("arguments", {})
        if tool_name not in TOOLS:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown tool: {tool_name}"},
            }
        
        schema_props = TOOLS[tool_name]["input_schema"].get("properties", {})
        for key, value in list(tool_args.items()):
            prop_schema = schema_props.get(key, {})
            declared_type = prop_schema.get("type")
            if declared_type == "integer" and not isinstance(value, int):
                tool_args[key] = int(value)
            elif declared_type == "number" and not isinstance(value, (int, float)):
                tool_args[key] = float(value)
        try:
            result = TOOLS[tool_name]["handler"](**tool_args)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]},
            }
        except Exception:
            logger.exception(f"Tool error in {tool_name}")
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": "Internal tool error"},
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Unknown method: {method}"},
    }


def main():
    logger.info("MemPalace MCP Server starting...")
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            request = json.loads(line)
            response = handle_request(request)
            if response is not None:
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
        except KeyboardInterrupt:
            break
        except Exception as e:
            logger.error(f"Server error: {e}")


if __name__ == "__main__":
    main()

