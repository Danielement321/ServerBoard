#!/bin/bash
PORT=${1:-8000}
nohup uvicorn app:app --host 0.0.0.0 --port "$PORT" > server.log 2>&1 &
echo "Server started on port $PORT"
echo "SSH Port Forwarding Command:"
echo "ssh -L ${PORT}:localhost:${PORT} root@<your-server-ip>"
echo "Local Browser URL:"
echo "http://localhost:${PORT}"