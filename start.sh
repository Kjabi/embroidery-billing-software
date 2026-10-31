#!/bin/bash
cd "$(dirname "$0")"

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

PYTHON="${PYTHON:-.venv/bin/python}"
if [ ! -x "$PYTHON" ]; then
  echo "Python interpreter not found at $PYTHON. Create a virtual environment first." >&2
  exit 1
fi

echo "🚀 Setting up Backend (FastAPI + SQLite + ReportLab)..."
cd backend
"../$PYTHON" -m pip install -r requirements.txt
"../$PYTHON" -m uvicorn main:app --host 127.0.0.1 --port 8000 &
BACKEND_PID=$!

echo "🎨 Setting up Frontend (React + Vite + Tailwind + Recharts)..."
cd ../frontend
npm install
npm run dev

kill $BACKEND_PID
