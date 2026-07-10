#!/bin/bash

# Stop script on errors
set -e

echo "🚀 Starting ChronoX Development Environment..."

# 1. Database and cache are managed locally (SQLite + Memory Cache) - No Docker needed.

# 2. Build WebAssembly module if pkg/ folder is missing
if [ ! -d "packages/wasm/pkg" ]; then
    echo "🦀 Compiling WebAssembly module for the first time..."
    cd packages/wasm
    PATH=$HOME/.cargo/bin:$PATH wasm-pack build --target bundler
    cd ../..
fi

# Cleanup handler on exit (Ctrl + C)
cleanup() {
    echo -e "\n🛑 Stopping ChronoX servers..."
    # Kill background tasks
    kill $BACKEND_PID $AI_PID $FRONTEND_PID 2>/dev/null || true
    exit 0
}

# Bind cleanup function to Ctrl+C (SIGINT) and exit (SIGTERM)
trap cleanup SIGINT SIGTERM

# 3. Start Rust Core Backend Server in background
echo "🦀 Starting Rust Core Backend on http://127.0.0.1:8000..."
cd services/core-backend
PATH=$HOME/.cargo/bin:$PATH cargo run --release &
BACKEND_PID=$!
cd ../..

# 4. Start Python AI Worker in background (needs .venv — see README)
if [ -x "services/ai-worker/.venv/bin/python" ]; then
    echo "🐍 Starting Python AI Worker on http://127.0.0.1:8001..."
    cd services/ai-worker
    ./.venv/bin/python worker.py &
    AI_PID=$!
    cd ../..
else
    echo "⚠️  Skipping AI Worker: services/ai-worker/.venv not found (see README to set it up)."
fi

# 5. Start Next.js Frontend Server in background
echo "🌐 Starting Next.js Frontend Server on http://localhost:3000..."
bun dev:web &
FRONTEND_PID=$!

# Keep script running to print outputs and wait for cleanup
wait
