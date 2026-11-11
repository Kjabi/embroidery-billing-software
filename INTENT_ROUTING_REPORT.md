# Intent Routing Report

## Implemented

The existing deterministic planner routes structured business questions to
allowlisted SQL tools and workflows. `hybrid_ai.QueryPlan` now validates the
logical route categories: `RAG_ONLY`, `SQL_ONLY`, `HYBRID_RAG_SQL`,
`BUSINESS_ACTION`, `CLARIFICATION`, and `UNSUPPORTED`.

Knowledge-shaped questions are routed to approved-document retrieval. Missing
evidence returns an explicit knowledge-base limitation instead of a generic
help list or invented answer.

## Not yet implemented

Automatic hybrid multi-tool execution and LLM-produced structured plans require
staging benchmarks and evidence policy before enabling them.
