import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);

const PACKET_AUDIO = 1;
const PACKET_VIDEO = 2;

const rooms = new Map();
const peers = new Set();

function makeAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function frame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);

  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function sendText(peer, value) {
  if (peer.closed) return;

  try {
    peer.socket.write(
      frame(0x1, Buffer.from(JSON.stringify(value)))
    );
  } catch {}
}

function sendBinary(peer, data) {
  if (peer.closed || peer.socket.destroyed) {
    return false;
  }

  const kind = data[0];
  const queued = peer.socket.writableLength;

  if (
    kind === PACKET_VIDEO &&
    (peer.socket.writableNeedDrain || queued > 48_000)
  ) {
    return false;
  }

  if (
    kind === PACKET_AUDIO &&
    queued > 128_000
  ) {
    return false;
  }

  try {
    peer.socket.write(frame(0x2, data));
    return true;
  } catch {
    return false;
  }
}
 

function sendPong(peer, payload) {
  if (peer.closed) return;

  try {
    peer.socket.write(frame(0xA, payload));
  } catch {}
}

function sendClose(peer, code = 1000, reason = '') {
  if (peer.closed) return;

  const reasonBytes = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBytes.length);

  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);

  try {
    peer.socket.write(frame(0x8, payload));
  } catch {}
}

function broadcastCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const peer of room.peers) {
    sendText(peer, {
      type: 'peer-count',
      peers: room.peers.size
    });
  }
}

function cleanup(peer) {
  if (peer.closed) return;

  peer.closed = true;

  if (peer.roomId) {
    const room = rooms.get(peer.roomId);

    if (room) {
      room.peers.delete(peer);

      if (room.peers.size === 0) {
        rooms.delete(peer.roomId);
      } else {
        broadcastCount(peer.roomId);
      }
    }
  }

  peers.delete(peer);

  try {
    peer.socket.destroy();
  } catch {}
}

function closePeer(peer, code, reason) {
  sendClose(peer, code, reason);
  cleanup(peer);
}

function handleJson(peer, message) {
  if (message.type === 'ping') {
    sendText(peer, {
      type: 'pong',
      at: message.at
    });

    return;
  }

  if (
    peer.joined &&
    (
      message.type === 'camera-state' ||
      message.type === 'request-keyframe'
    )
  ) {
    const room = rooms.get(peer.roomId);
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

    for (const other of room.peers) {
      if (other !== peer) {
        sendText(other, relayed);
      }
    }

    return;
  }

  if (message.type !== 'join' || peer.joined) {
    return;
  }

  const roomId =
    String(message.room || '').toUpperCase();

  const proof =
    String(message.proof || '');

  if (
    !/^[A-Z0-9-]{4,24}$/.test(roomId) ||
    !/^[a-f0-9]{64}$/.test(proof)
  ) {
    sendText(peer, {
      type: 'error',
      message: 'Invalid room information.'
    });

    closePeer(peer, 1008, 'invalid room');
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
    sendText(peer, {
      type: 'error',
      message: 'Wrong passphrase for this room.'
    });

    closePeer(peer, 1008, 'wrong passphrase');
    return;
  }

  if (room.peers.size >= 2) {
    sendText(peer, {
      type: 'error',
      message: 'This room already has two callers.'
    });

    closePeer(peer, 1008, 'room full');
    return;
  }

  room.peers.add(peer);

  peer.roomId = roomId;
  peer.joined = true;

  console.log(
    `Joined room ${roomId} (${room.peers.size}/2)`
  );

  sendText(peer, {
    type: 'joined',
    peers: room.peers.size
  });

  broadcastCount(roomId);
}

function handleBinary(peer, data) {
  if (!peer.joined || data.length < 2) return;

  const kind = data[0];

  if (
    kind === PACKET_AUDIO &&
    data.length > 4097
  ) {
    return;
  }

  if (
    kind === PACKET_VIDEO &&
    data.length > 300000
  ) {
    return;
  }

  if (
    kind !== PACKET_AUDIO &&
    kind !== PACKET_VIDEO
  ) {
    return;
  }

  const room = rooms.get(peer.roomId);
  if (!room) return;
let videoDropped = false;

for (const other of room.peers) {
  if (other !== peer) {
    const sent = sendBinary(other, data);

    if (kind === PACKET_VIDEO && !sent) {
      videoDropped = true;
    }
  }
}

if (videoDropped) {
  const now = Date.now();

  if (
    !peer.lastKeyframeRequestAt ||
    now - peer.lastKeyframeRequestAt > 1000
  ) {
    peer.lastKeyframeRequestAt = now;

    sendText(peer, {
      type: 'request-keyframe'
    });
  }
}

// CLOSE handleBinary()
}

function processFrame(peer, opcode, payload) {
function processFrame(peer, opcode, payload) {
  if (opcode === 0x8) {
    cleanup(peer);
    return;
  }

  if (opcode === 0x9) {
    sendPong(peer, payload);
    return;
  }

  if (opcode === 0xA) {
    return;
  }

  const now = Date.now();

  if (now - peer.windowStart >= 1000) {
    peer.windowStart = now;
    peer.frames = 0;
    peer.bytes = 0;
  }

  peer.frames += 1;
  peer.bytes += payload.length;

  if (
    peer.frames > 180 ||
    peer.bytes > 3200000
  ) {
    return;
  }

  if (opcode === 0x1) {
    let message;

    try {
      message = JSON.parse(
        payload.toString('utf8')
      );
    } catch {
      return;
    }

    handleJson(peer, message);
  }

  if (opcode === 0x2) {
    handleBinary(peer, payload);
  }
}

function parseFrames(peer) {
  let buffer = peer.buffer;

  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];

    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);

    let length = second & 0x7f;
    let offset = 2;

    if (!fin) {
      closePeer(
        peer,
        1003,
        'fragmented frames unsupported'
      );

      return;
    }

    if (!masked) {
      closePeer(
        peer,
        1002,
        'client frames must be masked'
      );

      return;
    }

    if (length === 126) {
      if (buffer.length < 4) break;

      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) break;

      const bigLength =
        buffer.readBigUInt64BE(2);

      if (bigLength > 300000n) {
        closePeer(
          peer,
          1009,
          'frame too large'
        );

        return;
      }

      length = Number(bigLength);
      offset = 10;
    }

    if (length > 300000) {
      closePeer(
        peer,
        1009,
        'frame too large'
      );

      return;
    }

    const frameLength =
      offset + 4 + length;

    if (buffer.length < frameLength) {
      break;
    }

    const mask =
      buffer.subarray(offset, offset + 4);

    offset += 4;

    const payload =
      Buffer.allocUnsafe(length);

    for (let i = 0; i < length; i++) {
      payload[i] =
        buffer[offset + i] ^
        mask[i % 4];
    }

    buffer =
      buffer.subarray(frameLength);

    processFrame(
      peer,
      opcode,
      payload
    );

    if (peer.closed) return;
  }

  peer.buffer = buffer;
}

const server =
  http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type':
        'text/plain; charset=utf-8',

      'Cache-Control':
        'no-store'
    });

    res.end(
      'LinkLine call server is online'
    );
  });

server.on(
  'upgrade',
  (req, socket) => {
    if (req.url !== '/api/ws') {
      socket.write(
        'HTTP/1.1 404 Not Found\r\n' +
        'Connection: close\r\n\r\n'
      );

      socket.destroy();
      return;
    }

    const upgrade =
      String(
        req.headers.upgrade || ''
      ).toLowerCase();

    const connection =
      String(
        req.headers.connection || ''
      ).toLowerCase();

    const key =
      req.headers[
        'sec-websocket-key'
      ];

    const version =
      req.headers[
        'sec-websocket-version'
      ];

    if (
      upgrade !== 'websocket' ||
      !connection.includes('upgrade') ||
      !key ||
      version !== '13'
    ) {
      socket.write(
        'HTTP/1.1 400 Bad Request\r\n' +
        'Connection: close\r\n\r\n'
      );

      socket.destroy();
      return;
    }

    const accept =
      makeAcceptKey(String(key));

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    const peer = {
      socket,
      buffer: Buffer.alloc(0),
      roomId: null,
      joined: false,
      closed: false,
      windowStart: Date.now(),
      frames: 0,
      bytes: 0
    };

    peers.add(peer);

    console.log(
      'WebSocket connected'
    );

    socket.on('data', (chunk) => {
      if (peer.closed) return;

      peer.buffer =
        Buffer.concat([
          peer.buffer,
          chunk
        ]);

      if (
        peer.buffer.length >
        600000
      ) {
        closePeer(
          peer,
          1009,
          'buffer too large'
        );

        return;
      }

      parseFrames(peer);
    });

    socket.on(
      'close',
      () => cleanup(peer)
    );

    socket.on(
      'end',
      () => cleanup(peer)
    );

    socket.on(
      'error',
      (error) => {
        console.error(
          'WebSocket socket error:',
          error.message
        );

        cleanup(peer);
      }
    );
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `LinkLine server running on port ${PORT}`
    );
  }
);
