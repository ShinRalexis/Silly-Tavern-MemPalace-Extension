"""
knowledge_graph.py — Temporal Entity-Relationship Graph for MemPalace
=====================================================================

Real knowledge graph with:
  - Entity nodes (people, projects, tools, concepts)
  - Typed relationship edges (daughter_of, does, loves, works_on, etc.)
  - Temporal validity (valid_from → valid_to — knows WHEN facts are true)
  - Closet references (links back to the verbatim memory)

Storage: SQLite (local, no dependencies, no subscriptions)
Query: entity-first traversal with time filtering

This is what competes with Zep's temporal knowledge graph.
Zep uses Neo4j in the cloud ($25/mo+). We use SQLite locally (free).

Usage:
    from mempalace.knowledge_graph import KnowledgeGraph

    kg = KnowledgeGraph()
    kg.add_triple("Max", "child_of", "Alice", valid_from="2015-04-01")
    kg.add_triple("Max", "does", "swimming", valid_from="2025-01-01")
    kg.add_triple("Max", "loves", "chess", valid_from="2025-10-01")

    # Query: everything about Max
    kg.query_entity("Max")

    # Query: what was true about Max in January 2026?
    kg.query_entity("Max", as_of="2026-01-15")

    # Query: who is connected to Alice?
    kg.query_entity("Alice", direction="both")

    # Invalidate: Max's sports injury resolved
    kg.invalidate("Max", "has_issue", "sports_injury", ended="2026-02-15")
"""

import hashlib
import json
import os
import sqlite3
from datetime import date, datetime
from pathlib import Path


DEFAULT_KG_PATH = os.path.expanduser("~/.mempalace/knowledge_graph.sqlite3")


class KnowledgeGraph:
    def __init__(self, db_path: str = None):
        self.db_path = db_path or DEFAULT_KG_PATH
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self):
        conn = self._conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT DEFAULT 'unknown',
                properties TEXT DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS triples (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                object TEXT NOT NULL,
                valid_from TEXT,
                valid_to TEXT,
                confidence REAL DEFAULT 1.0,
                source_closet TEXT,
                source_file TEXT,
                extracted_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (subject) REFERENCES entities(id),
                FOREIGN KEY (object) REFERENCES entities(id)
            );

            CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
            CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
            CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
            CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
            CREATE INDEX IF NOT EXISTS idx_triples_source ON triples(source_closet);
            CREATE INDEX IF NOT EXISTS idx_triples_extracted ON triples(extracted_at);
            CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
            CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
        """)
        
        # Migration: Ensure extracted_at and source_file exist for older databases
        try:
            conn.execute("ALTER TABLE triples ADD COLUMN extracted_at TEXT DEFAULT CURRENT_TIMESTAMP")
        except sqlite3.OperationalError:
            pass # Column already exists
            
        try:
            conn.execute("ALTER TABLE triples ADD COLUMN source_file TEXT")
        except sqlite3.OperationalError:
            pass # Column already exists
            
        conn.commit()
        conn.close()

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.row_factory = sqlite3.Row
        return conn

    def _entity_id(self, name: str) -> str:
        return name.lower().replace(" ", "_").replace("'", "")

    def _resolve_id(self, name: str, conn=None) -> str:
        """
        L'id di un'entita' come sta DAVVERO nel database, non come lo scriverebbe
        _entity_id().

        _entity_id() normalizza gli spazi ma non i trattini, quindi il personaggio
        salvato dal testo come "Mary-Jane" vive sotto 'mary-jane' mentre chi lo cerca
        partendo dal nome della wing ("Mary_Jane") chiede 'mary_jane' e non trova nulla:
        69 fatti irraggiungibili senza un solo errore a video. Qui si prova prima
        l'id esatto, poi si cercano le entita' il cui nome collassa sulla stessa
        forma una volta appiattiti trattini e spazi.

        Solo LETTURA: la scrittura continua a usare _entity_id(), cosi' gli id gia'
        nel database restano validi e non serve migrare niente.
        """
        eid = self._entity_id(name)
        proprio = conn is None
        if proprio:
            conn = self._conn()
        try:
            if conn.execute("SELECT 1 FROM entities WHERE id = ?", (eid,)).fetchone():
                return eid
            piatto = eid.replace("-", "_")
            row = conn.execute(
                "SELECT id FROM entities "
                "WHERE REPLACE(REPLACE(LOWER(name), '-', '_'), ' ', '_') = ? "
                "ORDER BY LENGTH(name) LIMIT 1",
                (piatto,),
            ).fetchone()
            return row["id"] if row else eid
        finally:
            if proprio:
                conn.close()

    # ── Write operations ──────────────────────────────────────────────────

    def add_entity(self, name: str, entity_type: str = "unknown", properties: dict = None):
        """Add or update an entity node."""
        eid = self._entity_id(name)
        props = json.dumps(properties or {})
        conn = self._conn()
        conn.execute(
            "INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)",
            (eid, name, entity_type, props),
        )
        conn.commit()
        conn.close()
        return eid

    def wipe_closet(self, source_closet: str, entity_name: str = None):
        """
        Delete facts associated with a specific closet (wing).
        If entity_name is provided, it tries to wipe all history for that entity 
        (Global reset).
        """
        conn = self._conn()
        if entity_name:
            # Wipe everything for this character (Global)
            eid = self._resolve_id(entity_name, conn)
            nome = entity_name.lower().strip()
            # Il closet si confronta ESATTO, più le sue eventuali wing di chat
            # ("Nome_chat_42"). Prima era `LIKE '%nome%'`, che è il contrario della
            # "massima sicurezza" promessa dal commento: cancellare la wing "Eva"
            # si portava via anche "Eva_Neri", e cancellare una wing di nome "End"
            # spazzava via "LEGEND". Un wipe che tracima in silenzio nella memoria
            # di un altro personaggio è il danno peggiore che questo file possa fare.
            conn.execute(
                "DELETE FROM triples WHERE subject = ? OR object = ? "
                "OR LOWER(source_closet) = ? OR LOWER(source_closet) LIKE ?",
                (eid, eid, nome, f"{nome}_chat_%"),
            )
            # Also clean the entity itself if it has no more relations
            conn.execute("DELETE FROM entities WHERE id NOT IN (SELECT subject FROM triples UNION SELECT object FROM triples)")
        elif source_closet:
            # Wipe only this specific closet (Session/Local)
            conn.execute("DELETE FROM triples WHERE LOWER(source_closet) = ?", (source_closet.lower().strip(),))
            
        conn.commit()
        conn.close()

    # Predicati che ammettono UN SOLO oggetto valido per volta: se il personaggio si
    # trasferisce, non "vive" in due posti — il fatto vecchio ha smesso di essere vero.
    # Sono pochi di proposito. "is_a" non c'e' dentro: si puo' essere un detective E
    # una combattente, e chiudere il primo fatto perche' e' arrivato il secondo
    # cancellerebbe meta' del personaggio.
    PREDICATI_ESCLUSIVI = {"lives_in", "works_at"}

    def add_triple(
        self,
        subject: str,
        predicate: str,
        obj: str,
        valid_from: str = None,
        valid_to: str = None,
        confidence: float = 1.0,
        source_closet: str = None,
        source_file: str = None,
        subject_type: str = "unknown",
        object_type: str = "unknown",
        supersede: bool = None,
    ):
        """
        Add a relationship triple: subject → predicate → object.

        Examples:
            add_triple("Max", "child_of", "Alice", valid_from="2015-04-01")
            add_triple("Max", "does", "swimming", valid_from="2025-01-01")
            add_triple("Alice", "worried_about", "Max injury", valid_from="2026-01", valid_to="2026-02")
        """
        sub_id = self._entity_id(subject)
        obj_id = self._entity_id(obj)
        pred = predicate.lower().replace(" ", "_")

        # Auto-create or update entities with types
        conn = self._conn()
        conn.execute("""
            INSERT INTO entities (id, name, type) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET type = excluded.type 
            WHERE entities.type = 'unknown' AND excluded.type != 'unknown'
        """, (sub_id, subject, subject_type))
        
        conn.execute("""
            INSERT INTO entities (id, name, type) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET type = excluded.type 
            WHERE entities.type = 'unknown' AND excluded.type != 'unknown'
        """, (obj_id, obj, object_type))

        # Check for existing identical triple — DENTRO LO STESSO CLOSET.
        # Senza il vincolo sul closet, due personaggi dello stesso mondo non possono
        # avere lo stesso fatto: il secondo che lo impara si vede restituire l'id del
        # primo, non viene scritto niente, e quel fatto resta per sempre nella memoria
        # di un personaggio solo. Silenzioso e indistinguibile da un successo.
        existing = conn.execute(
            "SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? "
            "AND valid_to IS NULL AND LOWER(COALESCE(source_closet,'')) = LOWER(COALESCE(?,''))",
            (sub_id, pred, obj_id, source_closet),
        ).fetchone()

        if existing:
            conn.close()
            return existing[0]  # Already exists and still valid

        from datetime import datetime
        if not valid_from:
            valid_from = datetime.now().strftime("%Y-%m-%d")

        # Il fatto nuovo CHIUDE quello vecchio quando i due non possono essere veri
        # insieme. E' cio' che trasforma un elenco di fatti in una memoria: senza,
        # il personaggio "vive" contemporaneamente in ogni citta' in cui abbia mai
        # abitato, e il RAG gliele ricorda tutte come se fossero il presente.
        # Si chiude solo dentro lo STESSO closet: la storia di un personaggio non
        # smentisce quella di un altro.
        if supersede is None:
            supersede = pred in self.PREDICATI_ESCLUSIVI
        if supersede:
            conn.execute(
                "UPDATE triples SET valid_to = ? "
                "WHERE subject = ? AND predicate = ? AND object != ? AND valid_to IS NULL "
                "AND (LOWER(COALESCE(source_closet,'')) = LOWER(COALESCE(?,'')))",
                (valid_from, sub_id, pred, obj_id, source_closet),
            )

        triple_id = f"t_{sub_id}_{pred}_{obj_id}_{hashlib.md5(f'{valid_from}{datetime.now().isoformat()}'.encode()).hexdigest()[:8]}"

        conn.execute(
            """INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                triple_id,
                sub_id,
                pred,
                obj_id,
                valid_from,
                valid_to,
                confidence,
                source_closet,
                source_file,
            ),
        )
        conn.commit()
        conn.close()
        return triple_id

    def invalidate(self, subject: str, predicate: str, obj: str, ended: str = None,
                   source_closet: str = None):
        """
        Mark a relationship as no longer valid (set valid_to date).

        source_closet limita l'effetto a un personaggio. Senza, chiudere "X ama Y"
        lo chiude in TUTTE le wing in cui quella tripla compare: due personaggi che
        condividono un mondo hanno spesso fatti identici parola per parola, e
        l'utente che ne archivia uno si vedrebbe sparire anche quello dell'altro.
        """
        conn = self._conn()
        sub_id = self._resolve_id(subject, conn)
        obj_id = self._resolve_id(obj, conn)
        pred = predicate.lower().replace(" ", "_")
        ended = ended or date.today().isoformat()

        query = "UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL"
        params = [ended, sub_id, pred, obj_id]
        if source_closet:
            query += " AND LOWER(COALESCE(source_closet,'')) = ?"
            params.append(source_closet.lower().strip())

        cur = conn.execute(query, params)
        chiusi = cur.rowcount
        conn.commit()
        conn.close()
        return chiusi

    # ── Query operations ──────────────────────────────────────────────────

    def query_closet(self, source_closet: str):
        """Get all facts associated with a specific closet (wing)."""
        conn = self._conn()
        query = """
            SELECT 
                t.id, t.subject, t.predicate, t.object, t.valid_from, t.valid_to, 
                t.confidence, t.source_closet, t.source_file, t.extracted_at,
                s.name as sub_name, o.name as obj_name
            FROM triples t
            JOIN entities s ON t.subject = s.id
            JOIN entities o ON t.object = o.id
            WHERE LOWER(t.source_closet) = ?
            ORDER BY t.extracted_at DESC
        """
        rows = conn.execute(query, (source_closet.lower(),)).fetchall()
        print(f"[KnowledgeGraph] query_closet for '{source_closet}' (lowered) found {len(rows)} raw rows")
        conn.close()
        
        return [
            {
                "subject": r["sub_name"],
                "predicate": r["predicate"],
                "object": r["obj_name"],
                "valid_from": r["valid_from"],
                "valid_to": r["valid_to"],
                "extracted_at": r["extracted_at"],
                "current": r["valid_to"] is None,
            }
            for r in rows
        ]

    def query_entity(self, name: str, as_of: str = None, direction: str = "outgoing"):
        """
        Get all relationships for an entity.

        direction: "outgoing" (entity → ?), "incoming" (? → entity), "both"
        as_of: date string — only return facts valid at that time
        """
        conn = self._conn()
        eid = self._resolve_id(name, conn)

        results = []

        if direction in ("outgoing", "both"):
            query = "SELECT t.*, e.name as obj_name FROM triples t JOIN entities e ON t.object = e.id WHERE t.subject = ?"
            params = [eid]
            if as_of:
                query += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)"
                params.extend([as_of, as_of])
            for row in conn.execute(query, params).fetchall():
                results.append(
                    {
                        "direction": "outgoing",
                        "subject": name,
                        "predicate": row[2],
                        "object": row[10],  # obj_name
                        "valid_from": row[4],
                        "valid_to": row[5],
                        "confidence": row[6],
                        "source_closet": row[7],
                        "current": row[5] is None,
                    }
                )

        if direction in ("incoming", "both"):
            query = "SELECT t.*, e.name as sub_name FROM triples t JOIN entities e ON t.subject = e.id WHERE t.object = ?"
            params = [eid]
            if as_of:
                query += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)"
                params.extend([as_of, as_of])
            for row in conn.execute(query, params).fetchall():
                results.append(
                    {
                        "direction": "incoming",
                        "subject": row[10],  # sub_name
                        "predicate": row[2],
                        "object": name,
                        "valid_from": row[4],
                        "valid_to": row[5],
                        "confidence": row[6],
                        "source_closet": row[7],
                        "current": row[5] is None,
                    }
                )

        conn.close()
        return results

    def query_neighbors(self, name: str, depth: int = 2, source_closet: str = None):
        """
        Get all facts for an entity and its neighbors up to a certain depth.

        source_closet limita la traversata ai fatti di quella wing. Senza, la rete
        sociale di un personaggio esce dal personaggio: il grafo e' UNO SOLO per
        tutti, gli id delle entita' sono globali, e basta una parola qualunque
        finita nel grafo come nodo (un "however", un "Well") per collegare fra loro
        wing che non c'entrano niente. Misurato su questo archivio: parole del
        genere comparivano in 11 wing diverse, e a profondita' 2 la maggioranza dei
        fatti restituiti per un personaggio apparteneva ad altri personaggi, che
        finivano dritti nel prompt. Il filtro va applicato PRIMA della traversata,
        non ai risultati: se il ponte lo si attraversa e basta, al giro dopo si e'
        gia' in casa d'altri.
        """
        conn = self._conn()
        eid = self._resolve_id(name, conn)

        visited = {eid}
        frontier = {eid}
        facts = []
        seen_ids = set()

        for _ in range(depth):
            if not frontier:
                break

            # Use a set of IDs for the query
            placeholders = ",".join(["?"] * len(frontier))
            query = f"""
                SELECT
                    t.id, t.subject, t.predicate, t.object, t.valid_from, t.valid_to,
                    t.confidence, t.source_closet, t.source_file, t.extracted_at,
                    s.name as sub_name, o.name as obj_name
                FROM triples t
                JOIN entities s ON t.subject = s.id
                JOIN entities o ON t.object = o.id
                WHERE (t.subject IN ({placeholders}) OR t.object IN ({placeholders}))
            """
            params = list(frontier) + list(frontier)
            if source_closet:
                query += " AND LOWER(t.source_closet) = ?"
                params.append(source_closet.lower())

            new_frontier = set()
            for r in conn.execute(query, params).fetchall():
                f_id = r["id"]
                # Avoid duplicates
                if f_id in seen_ids:
                    continue
                seen_ids.add(f_id)

                facts.append({
                    "id": f_id,
                    "subject": r["sub_name"],
                    "predicate": r["predicate"],
                    "object": r["obj_name"],
                    "valid_from": r["valid_from"],
                    "extracted_at": r["extracted_at"],
                    # Restituito sempre: senza, chi chiama non ha modo di accorgersi
                    # di un fatto altrui nemmeno volendo filtrare a valle.
                    "source_closet": r["source_closet"],
                    # Idem per la validita' temporale: la colonna c'era gia' nella
                    # SELECT ma non usciva, quindi chi leggeva la rete sociale non
                    # poteva sapere che un fatto era stato invalidato.
                    "valid_to": r["valid_to"],
                    "current": r["valid_to"] is None,
                })

                # Add discovered entities to next frontier
                if r["subject"] not in visited:
                    new_frontier.add(r["subject"])
                    visited.add(r["subject"])
                if r["object"] not in visited:
                    new_frontier.add(r["object"])
                    visited.add(r["object"])

            frontier = new_frontier

        conn.close()
        return facts

    def query_relationship(self, predicate: str, as_of: str = None):
        """Get all triples with a given relationship type."""
        pred = predicate.lower().replace(" ", "_")
        conn = self._conn()
        query = """
            SELECT t.*, s.name as sub_name, o.name as obj_name
            FROM triples t
            JOIN entities s ON t.subject = s.id
            JOIN entities o ON t.object = o.id
            WHERE t.predicate = ?
        """
        params = [pred]
        if as_of:
            query += " AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)"
            params.extend([as_of, as_of])

        results = []
        for row in conn.execute(query, params).fetchall():
            results.append(
                {
                    "subject": row[10],
                    "predicate": pred,
                    "object": row[11],
                    "valid_from": row[4],
                    "valid_to": row[5],
                    "current": row[5] is None,
                }
            )
        conn.close()
        return results

    def timeline(self, entity_name: str = None, source_closet: str = None):
        """Get facts in chronological order, optionally filtered by entity and/or closet."""
        conn = self._conn()
        params = []
        where_stmt = ""

        if source_closet:
            # Normalize: convert dashes, spaces, underscores to a common key for fuzzy LIKE match.
            # This ensures 'Mary-Jane', 'Mary_Jane', 'mary jane' all resolve to the same character.
            closet_key = source_closet.lower().replace("-", "%").replace("_", "%").replace(" ", "%")
            closet_like = f"%{closet_key}%"
            
            if entity_name:
                eid = self._entity_id(entity_name)
                where_stmt = "WHERE (t.subject = ? OR t.object = ? OR LOWER(t.source_closet) LIKE ?)"
                params = [eid, eid, closet_like]
            else:
                where_stmt = "WHERE LOWER(t.source_closet) LIKE ?"
                params = [closet_like]
        elif entity_name:
            eid = self._entity_id(entity_name)
            closet_like = f"%{entity_name.lower().strip()}%"
            where_stmt = "WHERE (t.subject = ? OR t.object = ? OR LOWER(t.source_closet) LIKE ?)"
            params = [eid, eid, closet_like]
            
        query = f"""
            SELECT 
                t.id, t.subject, t.predicate, t.object, t.valid_from, t.valid_to, 
                t.confidence, t.source_closet, t.source_file, t.extracted_at,
                s.name as sub_name, o.name as obj_name
            FROM triples t
            LEFT JOIN entities s ON t.subject = s.id
            LEFT JOIN entities o ON t.object = o.id
            {where_stmt}
            ORDER BY t.valid_from DESC NULLS LAST, t.extracted_at DESC
            LIMIT 100
        """
        rows = conn.execute(query, params).fetchall()
        conn.close()
        
        results = []
        for r in rows:
            # UI handles "date" field specifically
            fact_date = r["valid_from"] or r["extracted_at"][:10] or "2024-01-01"
            results.append({
                "id": r["id"],
                "subject": r["sub_name"] or r["subject"],
                "predicate": r["predicate"],
                "object": r["obj_name"] or r["object"],
                "date": fact_date,
                "valid_from": fact_date,
                "valid_to": r["valid_to"],
                "confidence": r["confidence"],
                "source_closet": r["source_closet"],
                "source_file": r["source_file"],
                "extracted_at": r["extracted_at"]
            })
        return results

    # ── Stats ─────────────────────────────────────────────────────────────

    def get_full_graph(self, character: str = None, wing: str = None, wings: list = None):
        """
        Get entities and relationships for visualization.

        I closet da mostrare si passano in `wings` (la wing d'identita' del
        personaggio piu' quella della chat in corso): il grafo e' la mappa della
        memoria di UN personaggio, e deve fermarsi li'.

        Prima il filtro era `(subject = eid OR object = eid) OR source_closet =
        wing`, con l'OR documentato come scelta "per essere inclusivi". Il problema
        e' che il ramo sull'entita' non aveva alcun vincolo di closet: bastava che
        il personaggio comparisse in un fatto di un altro personaggio e nella mappa
        sinaptica spuntavano archi che non gli appartenevano. Stessa falla di
        query_neighbors, in un posto diverso.
        """
        conn = self._conn()
        # _resolve_id e non _entity_id: chi chiama parte dal nome della wing
        # ("Mary_Jane") mentre nel grafo il nodo e' scritto come nel testo
        # ("Mary-Jane"), e il filtro non agganciava mai il protagonista.
        eid_filter = self._resolve_id(character, conn) if character else None
        closets = [w.lower().strip() for w in (wings or []) if w]
        if wing and wing.lower().strip() not in closets:
            closets.append(wing.lower().strip())
        wing_filter = closets[0] if len(closets) == 1 else None

        # 1. Fetch all entities
        entities = []
        for row in conn.execute("SELECT id, name, type FROM entities").fetchall():
            entities.append({
                "id": row["id"],
                "label": row["name"],
                "group": row["type"]
            })
            
        # 2. Fetch relationships
        edges = []
        query = "SELECT subject, predicate, object, source_closet FROM triples WHERE valid_to IS NULL"
        params = []
        
        if closets:
            # I closet delimitano il grafo. Se c'e' anche un personaggio, restringe
            # ulteriormente ai fatti che lo toccano DENTRO quei closet: e' un AND,
            # non piu' un OR, altrimenti il vincolo di closet non vincolerebbe niente.
            segnaposto = ",".join(["?"] * len(closets))
            query += f" AND LOWER(source_closet) IN ({segnaposto})"
            params.extend(closets)
        elif eid_filter:
            # Nessun closet indicato: si guarda il personaggio ovunque compaia.
            # E' la modalita' diagnostica, non quella usata dalla mappa sinaptica.
            query += " AND (subject = ? OR object = ?)"
            params.extend([eid_filter, eid_filter])

        rows = conn.execute(query, params).fetchall()
        print(f"[KnowledgeGraph] get_full_graph executed SQL: {query} with params {params}")
        print(f"[KnowledgeGraph] Found {len(rows)} matching edges")

        for row in rows:
            edges.append({
                "from": row["subject"],
                "to": row["object"],
                "label": row["predicate"]
            })
            
        # 3. Filter entities to only those present in the filtered edges
        if closets or eid_filter:
            connected_ids = set()
            for e in edges:
                connected_ids.add(e["from"])
                connected_ids.add(e["to"])
            if eid_filter:
                connected_ids.add(eid_filter)
            entities = [n for n in entities if n["id"] in connected_ids]
            
        conn.close()
        return {"nodes": entities, "edges": edges}

    def stats(self, wings: list = None):
        """
        Numeri del grafo, per uno o piu' closet oppure per l'archivio intero.

        `wings` non c'era, e la sua assenza si vedeva a schermo: il pannello
        chiedeva le statistiche passando la wing del personaggio, qui la wing veniva
        ignorata e tornavano i totali GLOBALI. Ogni personaggio mostrava lo stesso
        numero di nodi e di triple, e le "entita' principali" erano quelle del
        personaggio con piu' fatti in tutto l'archivio — indipendentemente da chi
        fosse aperto in quel momento. Una schermata che dice sempre la stessa cosa
        a prescindere dal soggetto e' peggio di una schermata vuota, perche' sembra
        che funzioni.
        """
        conn = self._conn()
        closets = [w.lower().strip() for w in (wings or []) if w]

        if closets:
            segnaposto = ",".join(["?"] * len(closets))
            dove = f"WHERE LOWER(t.source_closet) IN ({segnaposto})"
            par = closets
        else:
            dove, par = "", []

        # `t.` come alias anche senza filtro: cosi' la stessa stringa vale per tutte
        # le query qui sotto e non serve tenerne due versioni allineate a mano.
        triples = conn.execute(f"SELECT COUNT(*) FROM triples t {dove}", par).fetchone()[0]
        current = conn.execute(
            f"SELECT COUNT(*) FROM triples t {dove}{' AND' if dove else 'WHERE'} t.valid_to IS NULL", par
        ).fetchone()[0]

        # Le entita' che contano sono quelle RAGGIUNGIBILI dai fatti di questi
        # closet, non tutte quelle presenti nella tabella: un nodo senza archi in
        # questo contesto non fa parte di questo grafo.
        entities = conn.execute(
            f"SELECT COUNT(*) FROM (SELECT t.subject id FROM triples t {dove} "
            f"UNION SELECT t.object FROM triples t {dove})", par + par
        ).fetchone()[0]

        predicates = [
            r[0]
            for r in conn.execute(
                f"SELECT DISTINCT t.predicate FROM triples t {dove} ORDER BY t.predicate", par
            ).fetchall()
        ]

        # Get top entities by relationship count
        top_entities = [
            {"name": r["name"], "count": r["trip_count"]}
            for r in conn.execute(f"""
                SELECT e.name, COUNT(t.id) as trip_count
                FROM entities e
                JOIN triples t ON (e.id = t.subject OR e.id = t.object)
                {dove}
                GROUP BY e.name
                ORDER BY trip_count DESC
                LIMIT 10
            """, par).fetchall()
        ]
        conn.close()
        return {
            "entities": entities,
            "triples": triples,
            "current_facts": current,
            "relationship_types": predicates,
            "top_entities": top_entities,
        }

    # ── Seed from known facts ─────────────────────────────────────────────

    def seed_from_entity_facts(self, entity_facts: dict):
        """
        Seed the knowledge graph from fact_checker.py ENTITY_FACTS.
        This bootstraps the graph with known ground truth.
        """
        for key, facts in entity_facts.items():
            name = facts.get("full_name", key.capitalize())
            etype = facts.get("type", "person")
            self.add_entity(
                name,
                etype,
                {
                    "gender": facts.get("gender", ""),
                    "birthday": facts.get("birthday", ""),
                },
            )

            # Relationships
            parent = facts.get("parent")
            if parent:
                self.add_triple(
                    name, "child_of", parent.capitalize(), valid_from=facts.get("birthday")
                )

            partner = facts.get("partner")
            if partner:
                self.add_triple(name, "married_to", partner.capitalize())

            relationship = facts.get("relationship", "")
            if relationship == "daughter":
                self.add_triple(
                    name,
                    "is_child_of",
                    facts.get("parent", "").capitalize() or name,
                    valid_from=facts.get("birthday"),
                )
            elif relationship == "husband":
                self.add_triple(name, "is_partner_of", facts.get("partner", name).capitalize())
            elif relationship == "brother":
                self.add_triple(name, "is_sibling_of", facts.get("sibling", name).capitalize())
            elif relationship == "dog":
                self.add_triple(name, "is_pet_of", facts.get("owner", name).capitalize())
                self.add_entity(name, "animal")

            # Interests
            for interest in facts.get("interests", []):
                self.add_triple(name, "loves", interest.capitalize(), valid_from="2025-01-01")


    # Parole che non sono entita' ma che l'estrattore a regex promuoveva a nodo del
    # grafo: avverbi di frase, interiezioni, saluti, connettivi. Sono la specie piu'
    # dannosa di rumore perche' ricorrono in QUALSIASI conversazione, quindi lo stesso
    # nodo finisce collegato alle wing di decine di personaggi diversi e diventa un
    # ponte fra memorie che devono restare separate.
    NOISE_ENTITIES = [
        # pronomi e riempitivi (lista storica)
        "nothing", "something", "it", "everything", "them", "him", "her", "this",
        "that", "there", "she", "he", "they", "we", "i", "you", "who", "what",
        "where", "why", "how", "do you", "my tummy", "perfectly",
        "il", "la", "un", "una", "the", "a", "an", "is", "was", "era", "è",
        # avverbi e connettivi di frase
        "however", "now", "then", "so", "but", "and", "or", "also", "still", "just",
        "maybe", "anyway", "suddenly", "meanwhile", "finally", "actually", "honestly",
        "instead", "besides", "therefore", "though", "although", "meanwhile", "yet",
        "perhaps", "certainly", "obviously", "clearly", "basically", "literally",
        "eventually", "immediately", "slowly", "quickly", "later", "soon", "again",
        "always", "never", "sometimes", "often", "usually", "once", "twice",
        "here", "outside", "inside", "upstairs", "downstairs", "everywhere",
        "today", "tomorrow", "yesterday", "tonight",
        # interiezioni e saluti
        "oh", "ah", "eh", "uh", "um", "hm", "hmm", "wow", "yes", "no", "yeah", "nope",
        "okay", "ok", "please", "thanks", "thank you", "sorry", "hi", "hey", "hello",
        "well", "sure", "right", "good", "great", "fine", "alright", "indeed",
        "listen", "look", "wait", "stop", "come on", "god", "damn",
        # italiano
        "però", "quindi", "allora", "poi", "anche", "ancora", "sempre", "mai",
        "forse", "certo", "ecco", "beh", "ciao", "grazie", "scusa", "prego",
        "adesso", "dopo", "prima", "qui", "qua", "là", "lì", "fuori", "dentro",
        "sì", "no", "ok", "bene", "male", "molto", "poco", "tutto", "niente",
        # varie
        "etc", "ecc", "eg", "ie", "nan", "null", "none", "unknown",
    ]

    def wipe_noise(self):
        """Delete common pronouns and noise words from the graph."""
        conn = self._conn()
        cursor = conn.cursor()
        total_removed = 0
        for word in self.NOISE_ENTITIES:
            eid = self._entity_id(word)
            cursor.execute("DELETE FROM triples WHERE subject = ? OR object = ?", (eid, eid))
            total_removed += cursor.rowcount
            cursor.execute("DELETE FROM entities WHERE id = ?", (eid,))

        # I nodi-artefatto ("To Mary-Jane", "Key: Nome") NON si toccano da qui, anche
        # se sono spazzatura pure loro. Questo file puo' servire piu' palazzi
        # (archivi diversi con lo stesso codice): una regola che cancella per forma del nome
        # (contiene una virgola, comincia per "To ") su un archivio diverso da quello
        # per cui e' stata pensata puo' portarsi via entita' legittime. Vanno riparati,
        # non cancellati, e lo fa una migrazione una-tantum che riceve il percorso del
        # database per esteso, cosi' non puo' finire sull'archivio sbagliato.

        # Entita' rimaste senza piu' un solo fatto: non sono raggiungibili da nessuna
        # query e servono solo a gonfiare la tabella e i conteggi mostrati nella UI.
        cursor.execute(
            "DELETE FROM entities WHERE id NOT IN "
            "(SELECT subject FROM triples UNION SELECT object FROM triples)"
        )
        orphans = cursor.rowcount

        conn.commit()
        conn.close()
        print(f"[KnowledgeGraph] Noise wipe complete. Removed {total_removed} triples, {orphans} orphan entities.")
        return {"removed_triples": total_removed, "removed_entities": orphans}
