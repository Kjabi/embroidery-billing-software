# Security and Prompt-Injection Report

## Controls verified

- JWT/admin-session authentication remains required for voice and business APIs.
- Conversation state is keyed by admin ID and authenticated session ID.
- Write tools require preview plus explicit confirmation.
- Tool names and arguments are allowlisted/validated.
- The new retrieval layer reads only configured `.md`/`.txt` files and returns
  source names/content hashes.
- Retrieved text is never treated as instructions and cannot authorize tools.
- No raw audio is stored by the voice state module.

## Remaining tests

Prompt-injection corpus testing, unauthorized document-access tests, and
multi-worker shared-state testing remain staging work.
