#!/usr/bin/env python3
"""
searcher.py — Find anything. Exact words.

Semantic search against the palace.
Returns verbatim text — the actual words, never summaries.
"""

import logging
import threading
from pathlib import Path

import chromadb
from embed_multilingual import embedding_for
from config import MempalaceConfig

logger = logging.getLogger("mempalace_mcp")
_config = MempalaceConfig()


class SearchError(Exception):
    """Raised when search cannot proceed (e.g. no palace found)."""


# Un client ChromaDB per percorso, creato una volta sola e protetto da lock.
#
# Prima ogni ricerca ne costruiva uno nuovo: costoso, e soprattutto NON sicuro con
# piu' richieste insieme — due thread che aprono lo stesso archivio nello stesso
# istante si pestano i piedi e uno dei due torna "No palace found", cioe' una fase
# del RAG che sparisce senza motivo apparente. Si vedeva solo da quando le
# richieste sono davvero concorrenti (vedi run_in_threadpool in bridge.py).
# mcp_server.py faceva gia' cosi' per conto suo: qui si allinea.
_CLIENT_CACHE = {}
_CACHE_LOCK = threading.Lock()


def _collection(palace_path: str):
    chiave = (palace_path, _config.collection_name)
    col = _CLIENT_CACHE.get(chiave)
    if col is not None:
        return col
    with _CACHE_LOCK:
        col = _CLIENT_CACHE.get(chiave)  # ricontrollo: un altro thread puo' averla creata nel frattempo
        if col is None:
            client = chromadb.PersistentClient(path=palace_path)
            # L'embedding function va SEMPRE passata: senza, chromadb vettorizza la
            # query col modello di default e, se l'archivio e' indicizzato con un
            # altro, query e documenti finiscono in spazi diversi (risultati = rumore).
            col = client.get_collection(
                _config.collection_name, embedding_function=embedding_for(_config.config_dir)
            )
            _CLIENT_CACHE[chiave] = col
    return col


def _spazio_metrico(col) -> str:
    """Con che metrica e' costruito l'indice: 'l2' (il default di chromadb) o 'cosine'."""
    try:
        meta = col.metadata or {}
        return str(meta.get("hnsw:space", "l2")).lower()
    except Exception:
        return "l2"


def _coseno(dist: float, spazio: str) -> float:
    """
    La distanza di chromadb riportata su una scala che si puo' confrontare con una
    soglia scritta a mano.

    Questa collection e' nata senza `hnsw:space`, quindi l'indice e' in L2, e i
    vettori sono normalizzati: allora d = |a-b|^2 = 2 - 2cos, cioe' cos = 1 - d/2.
    Il campo `similarity` che il server ha sempre restituito e' invece 1 - d, che
    vale 2cos - 1: sulla stessa coppia di testi dice 0.30 dove il coseno dice 0.65,
    e sotto un coseno di 0.5 diventa NEGATIVO. Chi in interfaccia muoveva un cursore
    "rilevanza 0..1" pensando ai coseni stava in realta' chiedendo il doppio di
    quello che credeva, e a 0.3 buttava via quasi tutto.
    """
    if spazio == "cosine":
        return max(-1.0, min(1.0, 1 - dist))
    if spazio == "ip":
        return max(-1.0, min(1.0, dist))
    return max(-1.0, min(1.0, 1 - dist / 2))


def search(query: str, palace_path: str, wing: str = None, room: str = None, n_results: int = 5):
    """
    Search the palace. Returns verbatim drawer content.
    Optionally filter by wing (project) or room (aspect).
    """
    try:
        client = chromadb.PersistentClient(path=palace_path)
        # L'embedding function va SEMPRE passata: senza, chromadb vettorizza la query
        # con il modello di default e, se l'archivio e' indicizzato con un altro,
        # query e documenti finiscono in spazi diversi (risultati = rumore).
        col = client.get_collection(
            _config.collection_name, embedding_function=embedding_for(_config.config_dir)
        )
    except Exception:
        print(f"\n  No palace found at {palace_path}")
        print("  Run: mempalace init <dir> then mempalace mine <dir>")
        raise SearchError(f"No palace found at {palace_path}")

    # Build where filter
    where = {}
    if wing and room:
        where = {"$and": [{"wing": wing}, {"room": room}]}
    elif wing:
        where = {"wing": wing}
    elif room:
        where = {"room": room}

    try:
        kwargs = {
            "query_texts": [query],
            "n_results": n_results,
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            kwargs["where"] = where

        results = col.query(**kwargs)

    except Exception as e:
        print(f"\n  Search error: {e}")
        raise SearchError(f"Search error: {e}") from e

    docs = results["documents"][0]
    metas = results["metadatas"][0]
    dists = results["distances"][0]

    if not docs:
        print(f'\n  No results found for: "{query}"')
        return

    print(f"\n{'=' * 60}")
    print(f'  Results for: "{query}"')
    if wing:
        print(f"  Wing: {wing}")
    if room:
        print(f"  Room: {room}")
    print(f"{'=' * 60}\n")

    for i, (doc, meta, dist) in enumerate(zip(docs, metas, dists), 1):
        similarity = round(1 - dist, 3)
        source = Path(meta.get("source_file", "?")).name
        wing_name = meta.get("wing", "?")
        room_name = meta.get("room", "?")

        print(f"  [{i}] {wing_name} / {room_name}")
        print(f"      Source: {source}")
        print(f"      Match:  {similarity}")
        print()
        # Print the verbatim text, indented
        for line in doc.strip().split("\n"):
            print(f"      {line}")
        print()
        print(f"  {'─' * 56}")

    print()


def _filtro(wing=None, wings=None, room=None, room_exclude=None):
    """
    Il filtro `where` di chromadb per questa ricerca.

    wings (una lista) esiste perche' la lore di un mondo sta in una wing sua e i
    ricordi del personaggio in un'altra: una domanda sola deve poter pescare da
    entrambe senza fare due ricerche separate e poi rimescolarne i punteggi a mano,
    che ordinati in due liste diverse non sono confrontabili.

    room_exclude il frontend lo passava gia' da tempo ma qui non esisteva: chromadb
    ignora in silenzio le chiavi che non conosce, quindi la fase che doveva pescare
    solo ricordi episodici ha continuato a ricevere lore senza dare segno di niente.
    """
    clausole = []
    lista = [w for w in (wings or []) if w]
    if wing and wing not in lista:
        lista.append(wing)

    if len(lista) == 1:
        clausole.append({"wing": lista[0]})
    elif len(lista) > 1:
        clausole.append({"wing": {"$in": lista}})

    if room:
        clausole.append({"room": room})
    elif room_exclude:
        # Accetta una stanza sola o un elenco. Serve da quando le stanze non sono piu'
        # due o tre: una fase episodica deve poter escludere insieme la lore E le
        # aperture di chat, che sono scenografia di UNA partita e non cose accadute.
        # Chi passa una stringa continua a comportarsi come prima.
        escluse = room_exclude if isinstance(room_exclude, (list, tuple)) else [room_exclude]
        escluse = [r for r in escluse if r]
        if len(escluse) == 1:
            clausole.append({"room": {"$ne": escluse[0]}})
        elif len(escluse) > 1:
            clausole.append({"room": {"$nin": list(escluse)}})

    if not clausole:
        return {}
    return clausole[0] if len(clausole) == 1 else {"$and": clausole}


def search_memories(
    query: str,
    palace_path: str,
    wing: str = None,
    room: str = None,
    n_results: int = 5,
    wings: list = None,
    room_exclude: str = None,
) -> dict:
    """
    Programmatic search — returns a dict instead of printing.
    Used by the MCP server and other callers that need data.
    """
    try:
        col = _collection(palace_path)
    except Exception as e:
        logger.error("No palace found at %s: %s", palace_path, e)
        return {
            "error": "No palace found",
            "hint": "Run: mempalace init <dir> && mempalace mine <dir>",
        }

    where = _filtro(wing=wing, wings=wings, room=room, room_exclude=room_exclude)

    try:
        kwargs = {
            "query_texts": [query],
            "n_results": n_results,
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            kwargs["where"] = where

        results = col.query(**kwargs)
    except Exception as e:
        return {"error": f"Search error: {e}"}

    docs = results["documents"][0]
    metas = results["metadatas"][0]
    dists = results["distances"][0]
    ids = results["ids"][0]
    spazio = _spazio_metrico(col)
    hits = []
    for rid, doc, meta, dist in zip(ids, docs, metas, dists):
        hit = {
            "id": rid,
            "text": doc,
            "wing": meta.get("wing", "unknown"),
            "room": meta.get("room", "unknown"),
            "source_file": Path(meta.get("source_file", "?")).name,
            # Storico, lasciato com'e' per non rompere chi gia' lo legge: NON e' un
            # coseno e nello spazio l2 va tranquillamente sotto zero.
            "similarity": round(1 - dist, 3),
            # Questo si': 0..1, confrontabile con una soglia scritta da un umano.
            "cosine": round(_coseno(dist, spazio), 3),
        }
        # Includi tutti i metadati extra (come 'categoria')
        hit.update(meta)
        hits.append(hit)

    return {
        "query": query,
        "filters": {"wing": wing, "wings": wings, "room": room, "room_exclude": room_exclude},
        "space": spazio,
        "results": hits,
    }

def format_results_narrative(results: dict, agent_name: str = "Assistant") -> str:
    """
    Transforms raw search results into a clean, narrative string.
    Removes technical metadata like similarity scores and internal paths.
    """
    hits = results.get("results", [])
    if not hits:
        return ""

    lines = []
    lines.append(f"[Relevant recollections for {agent_name}]:")

    for hit in hits:
        text = hit.get("text", "").strip()
        # Use category or room as a friendly label
        cat = hit.get("categoria", hit.get("room", "Note")).capitalize()
        # Clean line: no similarity, no internal wing paths, no technical symbols
        lines.append(f"* ({cat}) {text}")

    return "\n".join(lines)
