---
type: Guide
title: Set Up Ollama
description: Install, configure, and control the local models used by Folio.
tags:
  - getting-started
  - ollama
  - local-ai
status: stable
generated:
  by: human:folio
  at: 2026-09-03T12:00:00.000Z
folio_related:
  - /getting-started/start-here.md
  - /getting-started/search-ask-and-workspace.md
---

# Set Up Ollama

Folio uses Ollama locally for three jobs:

- **Capture** classifies and files a note with `llama3.2:3b`.
- **Search** creates semantic embeddings with `embeddinggemma`.
- **Ask** answers questions from retrieved notes with `llama3.2:3b` by default.

## Setup

1. Install Ollama from `ollama.com/download` and start it.
2. Return to Folio. The upper-right status area should change to **Ollama online**.
3. If models are missing, select **Install models** in the status area.
4. Use the small status buttons to start or stop an individual model.

Manual installation is also possible:

```sh
ollama pull llama3.2:3b
ollama pull embeddinggemma
```

## If Ollama is offline

You can still capture notes. Folio preserves the raw text and files the note under **Unsorted Note**, but it cannot classify or semantically index the note until Ollama is available. Offline notes are not automatically reclassified later.

Everything stays local: Folio does not require an account or cloud service.
