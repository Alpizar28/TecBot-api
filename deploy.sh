#!/bin/bash
# deploy.sh — Pull latest code, rebuild and restart the TEC Brain monorepo

set -e  # Exit immediately on any error

echo "=================================================="
echo " TEC Brain Monorepo — Deploy Script"
echo "=================================================="

echo ""
echo ">>> [1/3] Pulling latest code from GitHub..."
git pull origin main || echo "  (First deploy, nothing to pull or branch not set yet)"

echo ""
echo ">>> [2/3] Building and starting Docker containers..."
sudo docker compose up -d --build

echo ""
echo "✅ Deployment complete! Containers are running."
echo "   Streaming logs from the Core Orchestrator (Ctrl+C to stop watching)..."
echo ""

sleep 5  # Give the containers a moment to start
sudo docker compose logs -f core
