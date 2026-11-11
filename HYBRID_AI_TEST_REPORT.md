# Hybrid AI Test Report

New tests cover strict query-plan/tool validation, confirmation requirements,
approved-file retrieval, heading-preserving chunks, source hashes, and the
no-evidence refusal path. Existing voice and business tests remain applicable.

Run the isolated backend suite with:

```bash
PYTHONPATH=backend pytest -q backend/tests
```

Production database, production documents, paid providers, and deployment were
not used.
