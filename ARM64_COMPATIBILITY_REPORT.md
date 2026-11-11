# ARM64 Compatibility Report

**Date:** 2026-11-07
**Scope:** whether the existing backend dependencies install and run on Linux ARM64 (Oracle Ampere A1), and what remains untested
**Target:** Debian 12 "bookworm" ARM64 (`python:3.12-slim-bookworm`), glibc 2.36, CPython 3.12
**Status:** **dependency resolution PASS on paper; runtime NOT TESTED.**

> Wheel availability is necessary but not sufficient. No ARM64 Linux process, container or
> Oracle instance was started. Docker's daemon is unavailable on this machine, so an
> emulated `docker build` could not be run either.

## 1. Method

From the repository root, the core requirements were filtered to match what the production
Dockerfile installs (it removes `faster-whisper`), then resolved for ARM64:

```bash
grep -v '^faster-whisper' backend/requirements.txt | grep -v '^#' | grep -v '^$' > req.txt
pip download --dest wheels \
  --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 \
  --python-version 312 --implementation cp --only-binary=:all: \
  -r req.txt
```

`--only-binary=:all:` means **no source build** is allowed; every dependency had to resolve
to a published wheel. Exit code was 0.

Method note: an earlier attempt added `--abi cp312`, which excludes `abi3` wheels and made
`tokenizers`/`av` look unavailable. That was a pip flag artefact, not a real incompatibility.
The results below are from the corrected command.

## 2. Core production set (image excludes `faster-whisper`)

All wheels resolved. Native packages:

| Package | Resolved version | Wheel tag |
|---|---|---|
| SQLAlchemy | 2.0.35 | `cp312-manylinux_2_17_aarch64.manylinux2014_aarch64` |
| Pillow | 11.3.0 | `cp312-manylinux2014_aarch64.manylinux_2_17_aarch64` |
| psycopg | 3.2.13 | `py3-none-any` |
| psycopg-binary | 3.2.13 | `cp312-manylinux2014_aarch64.manylinux_2_17_aarch64` |
| pydantic-core | 2.50.4 | `cp312-manylinux2014_aarch64.manylinux_2_17_aarch64` |
| chardet (reportlab dependency) | 7.7.0 | `cp312-manylinux_2_28_aarch64.manylinux2014_aarch64` |

Pure-Python or platform-independent: `fastapi 0.115.0`, `starlette 0.38.6`,
`uvicorn 0.30.6`, `pydantic 2.14.3`, `reportlab 4.2.2`, `python-multipart 0.0.33`,
`certifi 2026.10.23`, `httpx 0.28.1`, `httpcore 1.0.9`, `anyio 4.16.0`, `click`, `h11`,
`idna`, `typing_extensions`, `typing_inspection`, `annotated_types`, `pytest 8.4.2`,
`pluggy`, `iniconfig`, `packaging`, `pygments`.

**Result:** the production image needs **no compiler and no source build** on ARM64.

## 3. Optional local speech set (`faster-whisper`)

Although excluded from the production image, the optional server-side transcription path
was checked too, because an operator may enable it:

```bash
pip download --platform manylinux2014_aarch64 --platform manylinux_2_28_aarch64 \
  --python-version 312 --implementation cp --only-binary=:all: 'faster-whisper==1.2.1'
```

| Package | Resolved version | Wheel tag |
|---|---|---|
| faster-whisper | 1.2.1 | `py3-none-any` |
| ctranslate2 | 4.8.5 | `cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64` |
| onnxruntime | 1.31.1 | `cp312-manylinux_2_28_aarch64` |
| tokenizers | 0.23.3 | `cp310-abi3-manylinux_2_17_aarch64.manylinux2014_aarch64` |
| numpy | 2.5.4 | `cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64` |
| av (PyAV) | 19.0.2 | `cp312-abi3-manylinux_2_28_aarch64` |
| hf-xet | 1.8.0 | `cp38-abi3-manylinux_2_28_aarch64` |
| protobuf | 7.36.2 | `cp310-abi3-manylinux2014_aarch64` |
| PyYAML | 6.0.3 | `cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64` |

`onnxruntime` has **no `manylinux2014` (glibc 2.17) aarch64 wheel** for 1.31.1; it publishes
`manylinux_2_28_aarch64`. Debian bookworm's glibc 2.36 satisfies this. Do **not** switch the
base image to an older distro (e.g. CentOS 7 / glibc 2.17) if you intend to enable
`faster-whisper`.

## 4. glibc / libc constraints

- The image uses glibc (Debian), not musl. Alpine/musl wheels were not checked and are not
  used by `deploy/Dockerfile`.
- Wheels requiring `manylinux_2_28` need glibc ≥ 2.28. Debian bookworm (2.36) and Ubuntu
  24.04 (2.39) are both fine. Debian bullseye (2.31) is also fine.
- `cp310-abi3` wheels are stable-ABI wheels and load on CPython 3.12.
- Audio libraries for `av`/`ctranslate2` are bundled in the wheels; no system `ffmpeg`
  package is required for import, but actual decoding of non-WAV audio may still need codecs.
  **NOT TESTED.**

## 5. What is NOT tested

| Item | Status | Reason |
|---|---|---|
| `docker build` for `linux/arm64` | **NOT TESTED / BLOCKED** | Docker daemon unavailable |
| Running the ARM64 image | **NOT TESTED** | no ARM64 Linux host/emulator |
| Native import of every wheel on Linux ARM64 | **NOT TESTED** | wheel existence only |
| PDF generation on ARM64 | **NOT TESTED** | needs runtime |
| `faster-whisper` inference on ARM64 CPU | **NOT TESTED** | benchmark was M1 + Metal only |
| glibc 2.28 vs 2.36 runtime behaviour | **NOT TESTED** | no runtime |
| Memory/CPU of the A1 shape | **NOT TESTED** | see `ORACLE_ALWAYS_FREE_REPORT.md` |

The host machine used for this audit is itself `arm64` macOS, but macOS is **not** evidence
for Linux ARM64 ABI compatibility. That is why the table above is limited to wheel metadata.

## 6. How to complete the verification (when a Docker daemon or ARM64 host exists)

```bash
# On an ARM64 host, or with buildx + QEMU:
docker buildx build --platform linux/arm64 -f deploy/Dockerfile -t lalithas-backend:arm64 .
docker run --rm --platform linux/arm64 \
  -e APP_ENV=test -e APP_SECRET_KEY=test-key -e ADMIN_INITIAL_PASSWORD=test-pass \
  -e APP_DATA_DIR=/tmp/data -e APP_BACKUP_DIR=/tmp/backups \
  lalithas-backend:arm64 \
  python -c "import fastapi, sqlalchemy, psycopg, PIL, reportlab, multipart; print('imports ok')"
```

Then run the backend test suite inside the image and record the result here.

## 7. Verdict

- **ARM64 wheel availability for the shipped image: PASS** (resolved with `--only-binary`,
  exit 0, no source build).
- **Optional `faster-whisper` stack: PASS on paper** (requires glibc ≥ 2.28).
- **ARM64 build/runtime: NOT TESTED / BLOCKED.**
- Do not claim "ARM64 verified" until the build and an in-image import/test run are recorded.
