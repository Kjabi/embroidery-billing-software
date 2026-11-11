# RAG Document Ingestion Guide

## Current safe baseline

The retrieval baseline accepts only administrator-approved Markdown/text files
placed in `VOICE_KNOWLEDGE_DIR`. PDFs and DOCX files are not automatically
ingested because extraction, approval, size limits, metadata, and malware
handling have not yet been implemented.

## Planned staging pipeline

Validate type/size, extract text, preserve headings and tables, chunk with
metadata, generate a licensed multilingual embedding, store vectors privately,
verify ingestion, and expose admin-only retry/reindex/delete operations.
Never scan the entire repository or upload production documents during tests.
