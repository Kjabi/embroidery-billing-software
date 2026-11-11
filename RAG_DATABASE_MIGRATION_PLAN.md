# RAG Database Migration Plan

No database migration was applied.

Before production vector retrieval, create staging-only tables for approved
documents, versions, chunks, metadata, ingestion status, and embeddings (or
pgvector). Add admin ownership/access controls, content hashes, retry state,
and deletion/reindex semantics. Review indexes and migration behavior against
Supabase before requesting production approval.
