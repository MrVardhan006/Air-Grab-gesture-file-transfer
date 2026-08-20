// server.js
// Minimal signaling server for room-based device pairing.
// It never sees file contents — files travel peer-to-peer over WebRTC.
// This server only relays small JSON messages: "who's in the room" + WebRTC handshake info.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
// Files are at the repo root (no public/ subfolder) — serve straight from __dirname.
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// rooms: Map<roomCode, Set<ws>>
const rooms = new Map();

function roomPeers(roomCode) {
  return rooms.get(roomCode) || new Set();
}

function broadcastToRoom(roomCode, senderWs, payload) {
  for (const client of roomPeers(roomCode)) {
    if (client !== senderWs && client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.deviceName = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case 'join': {
        const { roomCode, deviceName } = msg;
        if (!roomCode) return;

        // Cap rooms at a small group so it stays simple (2-4 devices)
        if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
        const peers = rooms.get(roomCode);

        ws.roomCode = roomCode;
        ws.deviceName = deviceName || 'Unknown device';
        peers.add(ws);

        // Tell the newcomer who's already here
        const existingPeers = [...peers]
          .filter((c) => c !== ws)
          .map((c) => c.deviceName);
        ws.send(JSON.stringify({ type: 'joined', roomCode, peers: existingPeers }));

        // Tell everyone else someone new joined
        broadcastToRoom(roomCode, ws, { type: 'peer-joined', deviceName: ws.deviceName });
        break;
      }

      // WebRTC handshake relay (offer/answer/ice) — passed through untouched
      case 'signal': {
        if (!ws.roomCode) return;
        broadcastToRoom(ws.roomCode, ws, {
          type: 'signal',
          from: ws.deviceName,
          data: msg.data,
        });
        break;
      }

      // Gesture events, e.g. "grab" (armed a file) or "release" (ready to receive)
      case 'gesture': {
        if (!ws.roomCode) return;
        broadcastToRoom(ws.roomCode, ws, {
          type: 'gesture',
          from: ws.deviceName,
          gesture: msg.gesture,
          meta: msg.meta || null,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomCode && rooms.has(ws.roomCode)) {
      const peers = rooms.get(ws.roomCode);
      peers.delete(ws);
      broadcastToRoom(ws.roomCode, ws, { type: 'peer-left', deviceName: ws.deviceName });
      if (peers.size === 0) rooms.delete(ws.roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Gesture-transfer signaling server running on http://localhost:${PORT}`);
  console.log('Open this URL on two devices (same Wi-Fi, or via a tunnel like ngrok) to pair them.');
});
