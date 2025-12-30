#!/bin/bash
PORT=${1:-8000}
nohup uvicorn app:app --host 0.0.0.0 --port "$PORT" > server.log 2>&1 &