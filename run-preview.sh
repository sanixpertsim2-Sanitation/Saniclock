#!/bin/bash
# Preview runner for the SaniClock Node app inside the Emergent environment.
# Runs the same server on 3000 (HTML pages) and 8001 (/api/*) so the ingress
# (which routes /api -> 8001 and everything else -> 3000) serves one app.
pkill -f "node scale.js" 2>/dev/null
sleep 1
cd /app
export SANICLOCK_PASS='Saniclock2026!'
export SANICLOCK_USER='admin'
export SANICLOCK_SECRET='preview-shared-secret-123'
PORT=3000 nohup node scale.js > /tmp/node3000.log 2>&1 &
PORT=8001 nohup node scale.js > /tmp/node8001.log 2>&1 &
sleep 2
echo "restarted node on 3000 + 8001"
tail -1 /tmp/node3000.log
