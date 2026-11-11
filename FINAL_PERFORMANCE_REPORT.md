# Final Performance Report

**Date:** 2026-11-11

The production Vite build passed. Current generated assets include an
approximately 305 KiB main JavaScript chunk, 430 KiB lazy finance chunk, 599
KiB lazy Transformers chunk, and 25.6 MiB ONNX speech WASM asset. The frontend
logo is an approximately 15 KiB WebP.

Charts and voice are lazy-loaded, speech models are on-demand/cached, and
immutable caching is configured. No valid production Lighthouse score is
claimed because the prior report measured Vite development mode. A Preview
audit remains required.
