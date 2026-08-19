import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('LinkLine call server is online');
});

const wss = new WebSocketServer({
  server,
  path: '/api/ws',
  maxPayload: 300_000
});

const rooms = new Map();
const meta = new WeakMap();

const PACKET_AUDIO = 1;
const PACKET_VIDEO = 2;

function sendJson(ws, value) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function broadcastCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    sendJson(peer, {
      type: 'peer-count',
      peers: room.peers.size
    });
  }
}

function cleanup(ws) {
  const info = meta.get(ws);

  if (!info?.roomId) return;

  const room = rooms.get(info.roomId);
  if (!room) return;

  room.peers.delete(ws);

  if (room.peers.size === 0) {
    rooms.delete(info.roomId);
  } else {
    broadcastCount(info.roomId);
  }

  meta.delete(ws);
}

wss.on('connection', (ws) => {
  console.log('WebSocket connected');

  meta.set(ws, {
    roomId: null,
    joined: false,
    windowStart: Date.now(),
    frames: 0,
    bytes: 0
  });

  ws.on('message', (data, isBinary) => {
    const info = meta.get(ws);
    if (!info) return;

    const now = Date.now();

    if (now - info.windowStart >= 1000) {
      info.windowStart = now;
      info.frames = 0;
      info.bytes = 0;
    }

    info.frames++;
    info.bytes += data.byteLength;

    if (info.frames > 180 || info.bytes > 3_200_000) {
      return;
    }

    if (isBinary) {
      if (!info.joined || data.byteLength < 2) return;

      const kind = data[0];

      if (kind === PACKET_AUDIO && data.byteLength > 4097) return;
      if (kind === PACKET_VIDEO && data.byteLength > 300_000) return;

      if (kind !== PACKET_AUDIO && kind !== PACKET_VIDEO) {
        return;
      }

      const room = rooms.get(info.roomId);
      if (!room) return;

      for (const peer of room.peers) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(data, { binary: true });
        }
      }

      return;
    }

    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.type === 'ping') {
      sendJson(ws, {
        type: 'pong',
        at: message.at
      });
      return;
    }

    if (
      info.joined &&
      (
        message.type === 'camera-state' ||
        message.type === 'request-keyframe'
      )
    ) {
      const room = rooms.get(info.roomId);
      if (!room) return;

      const relayed =
        message.type === 'camera-state'
          ? {
              type: 'camera-state',
              enabled: Boolean(message.enabled)
            }
          : {
              type: 'request-keyframe'
            };

      for (const peer of room.peers) {
        if (peer !== ws) {
          sendJson(peer, relayed);
        }
      }

      return;
    }

    if (message.type !== 'join' || info.joined) {
      return;
    }

    const roomId = String(message.room || '').toUpperCase();
    const proof = String(message.proof || '');

    if (
      !/^[A-Z0-9-]{4,24}$/.test(roomId) ||
      !/^[a-f0-9]{64}$/.test(proof)
    ) {
      sendJson(ws, {
        type: 'error',
        message: 'Invalid room information.'
      });
      ws.close(1008, 'invalid room');
      return;
    }

    let room = rooms.get(roomId);

    if (!room) {
      room = {
        proof,
        peers: new Set()
      };
      rooms.set(roomId, room);
    }

    if (room.proof !== proof) {
      sendJson(ws, {
        type: 'error',
        message: 'Wrong passphrase for this room.'
      });
      ws.close(1008, 'wrong passphrase');
      return;
    }

    if (room.peers.size >= 2) {
      sendJson(ws, {
        type: 'error',
        message: 'This room already has two callers.'
      });
      ws.close(1008, 'room full');
      return;
    }

    room.peers.add(ws);
    info.roomId = roomId;
    info.joined = true;

    console.log(`Joined room ${roomId} (${room.peers.size}/2)`);

    sendJson(ws, {
      type: 'joined',
      peers: room.peers.size
    });

    broadcastCount(roomId);
  });

  ws.on('close', () => {
    cleanup(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    cleanup(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LinkLine server running on port ${PORT}`);
});
