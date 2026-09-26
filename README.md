# Second Brain

A private knowledge base you can question. Put your PDFs, lecture notes, saved articles and documentation in, then ask in plain language — and get an answer built only from your own material, where every claim carries a quote you can open and check.

Everything runs on your machine. The documents never leave it.

---

## What makes this more than "documents in a prompt"

Most RAG demos do three things: embed some text, find the nearest vectors, paste them into a prompt. That works in a demo and disappoints in use, for two reasons this project takes seriously.

### 1. Pure vector search fails on the queries people actually type

Embeddings capture meaning, which is exactly what you want for *"how do I stop the connection dropping"*, where none of the words in the answer appear in the question. They are noticeably bad at the opposite case: an error code, a person's name, `art. 1350`, a library version. A rare literal token barely moves a 384-dimension vector, so the right passage lands tenth.

Keyword search has the mirror-image strengths. So both run, on every query, and the two rankings are merged.

The merge is **Reciprocal Rank Fusion**. The obvious alternative — normalize the two scores and add them — quietly fails, because BM25 scores and cosine distances live on unrelated scales that shift with every query. RRF throws the scores away and keeps only the positions:

```
score(passage) = Σ over methods  1 / (60 + rank in that method)
```

A passage both methods rank highly wins. A passage only one method found still places well, which is the whole point: it rescues the exact matches vectors miss, and the paraphrases keywords miss, without either list being able to dominate.

The interface shows you this. Every result is tagged <kbd>keyword #2</kbd> or <kbd>vector #5</kbd>, so you can see *why* something was retrieved — and notice when one method is carrying the query alone.

### 2. "Grounded" is a claim, not a property

Putting your documents in the prompt does not stop a model blending a real passage with something it remembers from training. The result reads identically either way, which is the dangerous part.

So the answer is produced in a checkable form: the model must attach a **verbatim quote** to every claim, naming the passage it came from. Then the code goes and looks:

- Does that passage exist, and was it actually retrieved?
- Does the quote really appear in it?

A citation failing either check is discarded, and the sentence it supported is marked `unverified` in the answer. You are told how many were rejected and why.

The model's own confidence is corrected too. If it says "high" but a third of its citations were fabricated, the answer is downgraded to *partly answered* — because an answer where the checking failed is not a confident one, whatever the model asserted.

Finally, **"your documents don't cover this" is a correct answer**, and the prompt says so explicitly. A knowledge base that invents an answer about your own material is worse than useless.

---

## How it works

```
        ┌──────────── indexing (background queue) ─────────────┐
file →  extract text → reflow → chunk → embed → SQLite
        (PDF/DOCX/HTML)   ↑       ↑        ↑      ├── FTS5        (BM25, exact words)
                          │       │        │      └── sqlite-vec  (meaning)
                   rebuild paragraphs      │
                   and headings            └── local ONNX model, or OpenAI

        ┌──────────── asking ─────────────────────────────────┐
question → keyword search ┐
         → vector search  ┴→ RRF fusion → top passages → Claude → verify quotes → answer
```

### The parts that took the most care

**Chunking.** The single biggest quality lever, and the least glamorous. Passages are cut on structure rather than character count, because a chunk starting mid-sentence embeds as an average of two unrelated halves and retrieves badly. Consecutive chunks overlap by a sentence or two, so an answer straddling a seam survives — but overlap never crosses a section boundary, which would put one topic inside a chunk labelled with another. Each chunk carries its document title and nearest heading into the embedding: a paragraph reading *"it defaults to three retries"* means nothing alone, and a great deal under *"Retry policy"*.

**PDF reflow.** PDFs don't store paragraphs, they store lines, wrapped wherever the layout broke. Extracted text arrives with a newline in the middle of most sentences and no blank line between paragraphs — feed that to a chunker and a whole page is one block with every heading lost. A reflow pass decides, line by line, what continues a sentence and what starts something new, and re-emits headings as markdown so the chunker has one convention to read whatever the source format was.

**One index, two models is impossible.** Vectors from two different embedding models occupy different spaces and cannot be compared. Mixing them doesn't throw an error — it silently returns bad results, the worst failure mode there is. The model that built the index is recorded in the database, and a mismatch is refused with an explanation instead of being tolerated.

**Nothing is ever half-indexed.** If embedding fails partway, the chunks already written are rolled back, because a document present in keyword search but absent from semantic search is worse than one that isn't there at all. And if the process dies mid-run, the next start finds the unfinished document and rebuilds it from the stored text.

---

## Setup

### 1. Install

Requires **Node 22 or newer** (check with `node -v`).

```bash
npm install
```

`better-sqlite3` v13 and `sqlite-vec` ship precompiled binaries, so nothing is compiled on your machine and no build tools are needed — on Windows or anywhere else.

> **If you see a wall of C++ errors** mentioning `node-gyp`, `GetPrototype` or `MSBuild.exe`, you are on an older `better-sqlite3`. Versions before 13 use V8 APIs that were removed in recent Node releases and have no prebuilt binary for them, so npm tries to compile from source and fails. Fix it with:
> ```bash
> npm install better-sqlite3@^13.0.3
> ```
> Version 13 moved to N-API, which is what makes one prebuilt binary work across Node versions.

### 2. Configure

```bash
cp .env.example .env        # Windows cmd: copy .env.example .env
```

Add your Anthropic key for answering:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Search works entirely without it — only the written answer needs it.

### 3. Choose where embeddings come from

Anthropic has no embeddings API, so this is the one piece that needs another provider. Two options:

**Local (the default, recommended).** Runs a small ONNX model on your own CPU. Free, offline after the first download, and your documents never leave the machine — which is the whole point for a personal archive.

```bash
npm run setup:local
```

That installs `@huggingface/transformers` and downloads `Xenova/multilingual-e5-small` (about 120 MB, once). The model is multilingual, so Romanian and English documents share one index and a Romanian question can match an English passage.

**OpenAI.** Faster on large libraries, costs about two cents per million tokens, and sends every chunk of every document to their servers.

```
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

### 4. Check everything

```bash
npm run doctor
```

This actually loads the embedding model and runs it, rather than just reading `.env` — a wrong model produces quietly poor search instead of an error, so it is worth catching up front.

### 5. Run

```bash
npm start
```

Open [http://localhost:3007](http://localhost:3007).

---

## Using it

1. **Library → Add files.** Drop in PDFs, DOCX, TXT, Markdown or HTML. Indexing runs in the background with live progress; you can keep working. Re-adding a file you already have is recognised and skipped.
2. **Ask.** Type a question the way you'd say it. *Answer with citations* writes prose with checkable sources; *Search only* just lists the passages, which is faster and needs no API key.
3. **Click any citation** to open the passage it came from, with the quote highlighted, and expand to the surrounding text.
4. **Open "How these passages were found"** to see the two rankings and how they merged.

Collections are optional labels — put your Networking course in one and your work notes in another, then narrow a question to just one of them.

### Getting good answers

- **Ask a real question, not keywords.** Hybrid search handles both, but the answer step works from the question's meaning.
- **Notes with headings index better.** Structure is what the chunker cuts on, so a Markdown note with `##` headings retrieves far better than a wall of text.
- **If a PDF is a scan, it has no text.** The app says so rather than indexing an empty document. It needs OCR first — this project doesn't do OCR.
- **Trust the badge.** *Partly answered* and the `unverified` markers are the system telling you it couldn't back something up. That signal is the most useful thing here.

---

## Cost and privacy

| | |
|---|---|
| Local embeddings | free, offline, nothing transmitted |
| OpenAI embeddings | ~$0.02 per million tokens; your document text is sent to OpenAI |
| Answering | one Claude call per question; only the retrieved passages are sent, not your whole library |
| Search only | free, no network at all with local embeddings |

Everything is stored in `data/brain.db`. The server listens on `127.0.0.1`, so nothing on your network can reach it, and `data/`, `models/` and `.env` are gitignored.

---

## Project structure

```
secondbrain/
├── server.js               # REST API and the SSE progress stream
├── lib/
│   ├── db.js               # schema, migrations, FTS5 + sqlite-vec
│   ├── extract.js          # PDF / DOCX / HTML → text, page maps, reflow
│   ├── chunk.js            # structure-aware chunking with overlap
│   ├── embed.js            # local / OpenAI / offline providers
│   ├── search.js           # BM25 + vector KNN + RRF fusion
│   ├── answer.js           # prompt, and the citation verifier
│   ├── ingest.js           # pipeline, queue, recovery
│   └── text.js             # normalization, highlighting, quote checking
├── public/
│   ├── index.html, style.css
│   └── js/ main.js, answer.js, library.js, api.js, util.js
├── scripts/
│   ├── doctor.js           # environment check
│   ├── download-model.js   # pre-fetch the local model
│   └── reindex.js          # rebuild after changing model
└── test/                   # 28 tests
```

No framework and no build step: plain ES modules, native `<dialog>`, inline SVG.

## Tests

```bash
npm test
```

The ones worth reading are in `test/search.test.js`, which demonstrates why hybrid retrieval is necessary, and `test/answer.test.js`, which feeds the verifier a reply containing an invented quote and a citation to a source that was never retrieved, and checks both are caught.

Tests use an offline `hash` embedding provider — deterministic, no model, no network — so the suite runs anywhere in under a second.

## Changing the embedding model

```bash
# edit EMBEDDING_MODEL in .env, then:
npm run reindex
```

Because the extracted text is kept alongside each document, this rebuilds locally without asking you to find the original files again.

## Limits, honestly

- **No OCR.** Scanned PDFs are detected and reported, not read.
- **Vector search is exact, not approximate.** `sqlite-vec` scans every vector, which is fast up to roughly 100k passages — comfortably more than a personal library. Beyond that you'd want an ANN index or Postgres with pgvector, and the schema maps across cleanly.
- **No reranking model.** RRF fusion does the merging. A cross-encoder reranker would improve the top few results at the cost of another model download.
- **One user, one machine.** No accounts, no sharing — by design.

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Second Brain: hybrid-retrieval knowledge base with verified citations"
git branch -M main
git remote add origin <your_repo_url>
git push -u origin main
```
