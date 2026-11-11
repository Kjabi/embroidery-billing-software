# Voice Integration Report

The existing browser/local speech paths remain unchanged. Typed turns enter the
same authenticated `voice_agent.handle_turn` path. The new knowledge routing is
available to typed turns and therefore can be reached after transcription, but
microphone-to-RAG end-to-end testing was not run in this change.
