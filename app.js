
const $ = (id) => document.getElementById(id);
const els = {
  homeScreen: $('homeScreen'), setupCard: $('setupCard'), callCard: $('callCard'), roomInput: $('roomInput'), passwordInput: $('passwordInput'), showPasswordBtn: $('showPasswordBtn'),
  newRoomBtn: $('newRoomBtn'), joinBtn: $('joinBtn'), copyBtn: $('copyBtn'), setupMessage: $('setupMessage'),
  roomLabel: $('roomLabel'), statusPill: $('statusPill'), statusText: $('statusText'), peerText: $('peerText'),
  latencyText: $('latencyText'), qualityText: $('qualityText'), muteBtn: $('muteBtn'), muteLabel: $('muteLabel'),
  cameraBtn: $('cameraBtn'), cameraLabel: $('cameraLabel'), leaveBtn: $('leaveBtn'), fullscreenBtn: $('fullscreenBtn'),
  localVideo: $('localVideo'), localCameraOff: $('localCameraOff'), remoteCanvas: $('remoteCanvas'),
  remotePlaceholder: $('remotePlaceholder'), videoPlaceholderText: $('videoPlaceholderText'), captureCanvas: $('captureCanvas'), videoStage: $('videoStage')
};

const PACKET_AUDIO = 1;
const PACKET_VIDEO = 2;
const VIDEO_PACKET_HEADER = 16;
const VIDEO_PACKET_VERSION = 1;
const CODEC_VP8 = 1;

const QUALITY_TIERS = [
  { name: '720p', width: 1280, height: 720, fps: 24, bitrate: 900_000 },
  { name: '540p', width: 960, height: 540, fps: 20, bitrate: 550_000 },
  { name: '360p', width: 640, height: 360, fps: 15, bitrate: 280_000 }
];

let socket = null;
let stream = null;
let audioContext = null;
let captureNode = null;
let playerNode = null;
let muted = false;
let cameraEnabled = true;
let joinedRoom = null;
let reconnectTimer = null;
let intentionalClose = false;
let pingTimer = null;
let adaptiveTimer = null;
let peerCount = 0;
let latestRtt = 0;

let videoEncoder = null;
let videoDecoder = null;
let videoFrameCallbackId = null;
let videoInterval = null;
let lastVideoEncodeAt = 0;
let currentQualityIndex = 1;
let forceKeyFrame = true;
let framesSinceKey = 0;
let waitingForKeyFrame = true;
let decoderConfigKey = '';
let videoCodecSupported = false;
let qualityStableTicks = 0;

function randomRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes, b => chars[b % chars.length]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeRoom(value) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
}

async function roomProof(room, passphrase) {
  const data = new TextEncoder().encode(`linkline:v3:${room}:${passphrase}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/ws`;
}

function setSetupMessage(text, error = false, success = false) {
  els.setupMessage.innerHTML = `<span class="info-dot">${error ? '!' : (success ? '✓' : 'i')}</span><span></span>`;
  els.setupMessage.lastElementChild.textContent = text;
  els.setupMessage.classList.toggle('error', error);
  els.setupMessage.classList.toggle('success', success);
}

function setStatus(kind, text) {
  els.statusPill.className = `status ${kind}`;
  els.statusText.textContent = text;
}

function packetize(kind, payload) {
  const bytes = new Uint8Array(payload.byteLength + 1);
  bytes[0] = kind;
  bytes.set(new Uint8Array(payload), 1);
  return bytes.buffer;
}

function packetizeVideo(chunk, width, height) {
  const output = new Uint8Array(VIDEO_PACKET_HEADER + chunk.byteLength);
  const view = new DataView(output.buffer);
  output[0] = PACKET_VIDEO;
  output[1] = VIDEO_PACKET_VERSION;
  output[2] = CODEC_VP8;
  output[3] = chunk.type === 'key' ? 1 : 0;
  view.setUint16(4, width, false);
  view.setUint16(6, height, false);
  view.setBigUint64(8, BigInt(Math.max(0, Math.round(chunk.timestamp))), false);
  chunk.copyTo(output.subarray(VIDEO_PACKET_HEADER));
  return output.buffer;
}

async function checkWebCodecsSupport() {
  if (!window.VideoEncoder || !window.VideoDecoder || !window.VideoFrame || !window.EncodedVideoChunk) return false;
  try {
    const enc = await VideoEncoder.isConfigSupported({
      codec: 'vp8', width: 640, height: 360, bitrate: 550_000, framerate: 20, latencyMode: 'realtime'
    });
    const dec = await VideoDecoder.isConfigSupported({ codec: 'vp8', codedWidth: 640, codedHeight: 360 });
    return Boolean(enc.supported && dec.supported);
  } catch {
    return false;
  }
}

function currentTier() {
  return QUALITY_TIERS[currentQualityIndex];
}

function updateQualityLabel(extra = '') {
  const tier = currentTier();
  const suffix = extra ? ` · ${extra}` : '';
  els.qualityText.textContent = `${tier.name} · ${tier.fps} fps target${suffix}`;
}

function configureEncoder() {
  if (!videoEncoder || videoEncoder.state === 'closed') return;
  const tier = currentTier();
  els.captureCanvas.width = tier.width;
  els.captureCanvas.height = tier.height;
  if (videoEncoder.state === 'configured') {
    try { videoEncoder.reset(); } catch {}
  }
  videoEncoder.configure({
    codec: 'vp8',
    width: tier.width,
    height: tier.height,
    bitrate: tier.bitrate,
    framerate: tier.fps,
    latencyMode: 'realtime'
  });
  forceKeyFrame = true;
  framesSinceKey = 0;
  updateQualityLabel();
}

function createEncoder() {
  videoEncoder?.close();
  videoEncoder = new VideoEncoder({
    output: (chunk) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || peerCount < 2 || !cameraEnabled) return;
      const tier = currentTier();
      // Real-time calls should drop stale video instead of queueing it.
      // Keyframes get a little more room because they are larger.
      const maxBacklog = chunk.type === 'key' ? 192_000 : 64_000;
      if (socket.bufferedAmount > maxBacklog) return;
      socket.send(packetizeVideo(chunk, tier.width, tier.height));
    },
    error: (error) => {
      console.error('Video encoder error:', error);
      updateQualityLabel('encoder error');
    }
  });
  configureEncoder();
}

function createDecoder() {
  videoDecoder?.close();
  decoderConfigKey = '';
  waitingForKeyFrame = true;
  videoDecoder = new VideoDecoder({
    output: (frame) => {
      try {
        const width = frame.displayWidth || frame.codedWidth;
        const height = frame.displayHeight || frame.codedHeight;
        if (els.remoteCanvas.width !== width || els.remoteCanvas.height !== height) {
          els.remoteCanvas.width = width;
          els.remoteCanvas.height = height;
        }
        const ctx = els.remoteCanvas.getContext('2d', { alpha: false, desynchronized: true });
        ctx.drawImage(frame, 0, 0, els.remoteCanvas.width, els.remoteCanvas.height);
        els.remoteCanvas.classList.remove('hidden');
        els.remotePlaceholder.classList.add('hidden');
      } finally {
        frame.close();
      }
    },
    error: (error) => {
      console.error('Video decoder error:', error);
      waitingForKeyFrame = true;
      decoderConfigKey = '';
      setTimeout(() => {
        try { createDecoder(); } catch {}
        requestRemoteKeyFrame();
      }, 0);
    }
  });
}

function decodeVideoPacket(buffer) {
  if (!videoDecoder || buffer.byteLength <= VIDEO_PACKET_HEADER) return;
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== PACKET_VIDEO || bytes[1] !== VIDEO_PACKET_VERSION || bytes[2] !== CODEC_VP8) return;
  const view = new DataView(buffer);
  const isKey = Boolean(bytes[3] & 1);
  const width = view.getUint16(4, false);
  const height = view.getUint16(6, false);
  const timestamp = Number(view.getBigUint64(8, false));
  if (!width || !height || width > 1920 || height > 1080) return;

  const configKey = `${width}x${height}`;
  if (decoderConfigKey !== configKey) {
    try { videoDecoder.reset(); } catch {}
    videoDecoder.configure({ codec: 'vp8', codedWidth: width, codedHeight: height });
    decoderConfigKey = configKey;
    waitingForKeyFrame = true;
  }

  if (videoDecoder.decodeQueueSize > 4) {
    try { videoDecoder.reset(); } catch {}
    waitingForKeyFrame = true;
    requestRemoteKeyFrame();
  }

  if (waitingForKeyFrame && !isKey) return;
  if (isKey) waitingForKeyFrame = false;

  try {
    const chunk = new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp,
      data: bytes.subarray(VIDEO_PACKET_HEADER)
    });
    videoDecoder.decode(chunk);
  } catch (error) {
    console.warn('Dropped video packet:', error);
    waitingForKeyFrame = true;
    requestRemoteKeyFrame();
  }
}

function requestRemoteKeyFrame() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'request-keyframe' }));
  }
}

function encodeCurrentFrame(nowMs) {
  if (!videoEncoder || videoEncoder.state !== 'configured' || !cameraEnabled || peerCount < 2) return;
  if (!stream || els.localVideo.readyState < 2 || videoEncoder.encodeQueueSize > 1) return;
  const tier = currentTier();
  const minGap = 1000 / tier.fps;
  if (nowMs - lastVideoEncodeAt < minGap) return;
  lastVideoEncodeAt = nowMs;

  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return;

  const ctx = els.captureCanvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.drawImage(els.localVideo, 0, 0, tier.width, tier.height);

  let frame;
  try {
    frame = new VideoFrame(els.captureCanvas, { timestamp: Math.round(performance.now() * 1000) });
    const periodicKey = framesSinceKey >= tier.fps * 3;
    videoEncoder.encode(frame, { keyFrame: forceKeyFrame || periodicKey });
    if (forceKeyFrame || periodicKey) {
      forceKeyFrame = false;
      framesSinceKey = 0;
    } else {
      framesSinceKey += 1;
    }
  } catch (error) {
    console.warn('Could not encode frame:', error);
  } finally {
    frame?.close();
  }
}

function startVideoCapture() {
  stopVideoCapture();
  if (!videoCodecSupported) return;
  lastVideoEncodeAt = 0;

  if (typeof els.localVideo.requestVideoFrameCallback === 'function') {
    const loop = (now) => {
      encodeCurrentFrame(now);
      videoFrameCallbackId = els.localVideo.requestVideoFrameCallback(loop);
    };
    videoFrameCallbackId = els.localVideo.requestVideoFrameCallback(loop);
  } else {
    videoInterval = setInterval(() => encodeCurrentFrame(performance.now()), 20);
  }
}

function stopVideoCapture() {
  if (videoFrameCallbackId !== null && typeof els.localVideo.cancelVideoFrameCallback === 'function') {
    try { els.localVideo.cancelVideoFrameCallback(videoFrameCallbackId); } catch {}
  }
  videoFrameCallbackId = null;
  if (videoInterval) clearInterval(videoInterval);
  videoInterval = null;
}

function adaptQuality() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !videoEncoder || peerCount < 2) return;
  const buffered = socket.bufferedAmount;
  const overloaded = buffered > 120_000 || latestRtt > 275 || videoEncoder.encodeQueueSize > 2;
  const healthy = buffered < 24_000 && (latestRtt === 0 || latestRtt < 160) && videoEncoder.encodeQueueSize === 0;

  if (overloaded && currentQualityIndex < QUALITY_TIERS.length - 1) {
    currentQualityIndex += 1;
    qualityStableTicks = 0;
    configureEncoder();
    updateQualityLabel('auto reduced');
    return;
  }

  if (healthy) qualityStableTicks += 1;
  else qualityStableTicks = 0;

  // Stay conservative for ~12 seconds before moving back up a tier.
  if (qualityStableTicks >= 6 && currentQualityIndex > 0) {
    currentQualityIndex -= 1;
    qualityStableTicks = 0;
    configureEncoder();
    updateQualityLabel('auto increased');
  }
}

function startAdaptiveQuality() {
  stopAdaptiveQuality();
  adaptiveTimer = setInterval(adaptQuality, 2000);
}

function stopAdaptiveQuality() {
  if (adaptiveTimer) clearInterval(adaptiveTimer);
  adaptiveTimer = null;
}

async function initMedia() {
  if (audioContext) return;

  videoCodecSupported = await checkWebCodecsSupport();
  if (!videoCodecSupported) throw new Error('WebCodecs VP8 is not supported in this browser.');

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: {
      width: { ideal: 1280, min: 640 },
      height: { ideal: 720, min: 360 },
      frameRate: { ideal: 30, min: 15 },
      facingMode: 'user'
    }
  });

  els.localVideo.srcObject = stream;
  await els.localVideo.play().catch(() => {});

  audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  await audioContext.resume();

  const audioStream = new MediaStream(stream.getAudioTracks());
  const source = audioContext.createMediaStreamSource(audioStream);
  captureNode = new AudioWorkletNode(audioContext, 'mic-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });
  playerNode = new AudioWorkletNode(audioContext, 'stream-player', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  });

  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  source.connect(captureNode).connect(silentGain).connect(audioContext.destination);
  playerNode.connect(audioContext.destination);

  captureNode.port.onmessage = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || muted || peerCount < 2) return;
    // Prefer fresh voice over stale queued media. If the socket is badly
    // backed up, drop this tiny audio packet rather than adding more delay.
    if (event.data instanceof ArrayBuffer && socket.bufferedAmount < 128_000) {
      socket.send(packetize(PACKET_AUDIO, event.data));
    }
  };

  createEncoder();
  createDecoder();
  startVideoCapture();
  startAdaptiveQuality();
}

function clearRemoteVideo(message = 'Waiting for your friend') {
  els.remoteCanvas.classList.add('hidden');
  els.remotePlaceholder.classList.remove('hidden');
  els.videoPlaceholderText.textContent = message;
  const ctx = els.remoteCanvas.getContext('2d');
  ctx?.clearRect(0, 0, els.remoteCanvas.width, els.remoteCanvas.height);
  waitingForKeyFrame = true;
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  }, 5000);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

async function joinCall() {
  const room = normalizeRoom(els.roomInput.value.trim());
  const passphrase = els.passwordInput.value;
  if (room.length < 4) return setSetupMessage('Use a room code with at least 4 characters.', true);
  if (passphrase.length < 6) return setSetupMessage('Use a passphrase with at least 6 characters.', true);
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    return setSetupMessage('This browser does not support the media features LinkLine needs.', true);
  }

  els.joinBtn.disabled = true;
  setSetupMessage('Starting microphone, camera, and WebCodecs…');

  try {
    await initMedia();
    const proof = await roomProof(room, passphrase);
    joinedRoom = { room, proof };
    intentionalClose = false;
    connectSocket();
    els.roomLabel.textContent = room;
    els.homeScreen.classList.add('hidden');
    els.callCard.classList.remove('hidden');
    document.body.classList.add('in-call');
  } catch (error) {
    console.error(error);
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
    const message = denied
      ? 'Camera or microphone permission was denied.'
      : (error?.message?.includes('WebCodecs') ? error.message : 'Could not start the camera/microphone.');
    setSetupMessage(message, true);
    els.joinBtn.disabled = false;
    cleanupMedia();
  }
}

function handlePeerCount(peers) {
  peerCount = Number(peers || 0);
  const live = peerCount === 2;
  setStatus(live ? 'live' : 'waiting', live ? 'Live' : 'Waiting');
  els.peerText.textContent = live ? 'Friend connected' : 'Waiting for your friend';
  if (!live) {
    playerNode?.port.postMessage({ type: 'clear' });
    clearRemoteVideo('Waiting for your friend');
  } else {
    forceKeyFrame = true;
    socket?.send(JSON.stringify({ type: 'camera-state', enabled: cameraEnabled }));
    requestRemoteKeyFrame();
    if (els.remoteCanvas.classList.contains('hidden')) {
      els.videoPlaceholderText.textContent = 'Friend connected · starting camera…';
    }
  }
}

function connectSocket() {
  if (!joinedRoom) return;
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  setStatus('waiting', 'Connecting…');
  socket = new WebSocket(wsUrl());
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', ...joinedRoom }));
    startPing();
  });

  socket.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      const packet = new Uint8Array(event.data);
      if (packet.byteLength < 2) return;
      const kind = packet[0];
      if (kind === PACKET_AUDIO) {
        const payload = event.data.slice(1);
        playerNode?.port.postMessage(payload, [payload]);
      } else if (kind === PACKET_VIDEO) {
        decodeVideoPacket(event.data);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'joined' || msg.type === 'peer-count') handlePeerCount(msg.peers);
    if (msg.type === 'pong') {
      const now = Date.now();
      latestRtt = Math.max(0, now - Number(msg.at || now));
      els.latencyText.textContent = `Server round trip ~${latestRtt} ms`;
    }
    if (msg.type === 'camera-state') {
      if (msg.enabled) {
        els.videoPlaceholderText.textContent = 'Camera starting…';
        requestRemoteKeyFrame();
      } else {
        clearRemoteVideo('Friend turned camera off');
      }
    }
    if (msg.type === 'request-keyframe') forceKeyFrame = true;
    if (msg.type === 'error') {
      setStatus('offline', 'Error');
      els.peerText.textContent = msg.message || 'Could not join room';
    }
  });

  socket.addEventListener('close', () => {
    stopPing();
    peerCount = 0;
    if (intentionalClose || !joinedRoom) return;
    setStatus('offline', 'Disconnected');
    els.peerText.textContent = 'Reconnecting…';
    clearRemoteVideo('Reconnecting…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 1500);
  });
}

function cleanupMedia() {
  stopVideoCapture();
  stopAdaptiveQuality();
  try { videoEncoder?.close(); } catch {}
  try { videoDecoder?.close(); } catch {}
  videoEncoder = null;
  videoDecoder = null;
  decoderConfigKey = '';
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  els.localVideo.srcObject = null;
  captureNode?.disconnect();
  playerNode?.disconnect();
  captureNode = null;
  playerNode = null;
  audioContext?.close();
  audioContext = null;
}

function leaveCall() {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  stopPing();
  joinedRoom = null;
  peerCount = 0;
  latestRtt = 0;
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, 'left');
  socket = null;
  cleanupMedia();
  muted = false;
  cameraEnabled = true;
  currentQualityIndex = 1;
  qualityStableTicks = 0;
  els.muteBtn.classList.remove('active');
  els.muteBtn.setAttribute('aria-pressed', 'false');
  els.muteLabel.textContent = 'Mute';
  els.cameraBtn.classList.remove('active');
  els.cameraBtn.setAttribute('aria-pressed', 'false');
  els.cameraLabel.textContent = 'Camera';
  els.localVideo.classList.remove('camera-disabled');
  els.localCameraOff.classList.add('hidden');
  clearRemoteVideo();
  els.callCard.classList.add('hidden');
  els.homeScreen.classList.remove('hidden');
  document.body.classList.remove('in-call');
  els.joinBtn.disabled = false;
  els.latencyText.textContent = 'Secure transport ready';
  updateQualityLabel();
  setSetupMessage('Your browser will ask for microphone and camera permission when you join. The passphrase is never added to the invite URL.');
}

function toggleMute() {
  muted = !muted;
  captureNode?.port.postMessage({ type: 'mute', value: muted });
  for (const track of stream?.getAudioTracks?.() || []) track.enabled = !muted;
  els.muteBtn.classList.toggle('active', muted);
  els.muteBtn.setAttribute('aria-pressed', String(muted));
  els.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
  els.muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
}

function toggleCamera() {
  cameraEnabled = !cameraEnabled;
  for (const track of stream?.getVideoTracks?.() || []) track.enabled = cameraEnabled;
  els.cameraBtn.classList.toggle('active', !cameraEnabled);
  els.cameraBtn.setAttribute('aria-pressed', String(!cameraEnabled));
  els.cameraLabel.textContent = cameraEnabled ? 'Camera' : 'Camera off';
  els.cameraBtn.setAttribute('aria-label', cameraEnabled ? 'Turn camera off' : 'Turn camera on');
  els.localVideo.classList.toggle('camera-disabled', !cameraEnabled);
  els.localCameraOff.classList.toggle('hidden', cameraEnabled);
  if (cameraEnabled) forceKeyFrame = true;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'camera-state', enabled: cameraEnabled }));
  }
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await els.videoStage.requestFullscreen();
    else await document.exitFullscreen();
  } catch {}
}

async function copyInvite() {
  const room = normalizeRoom(els.roomInput.value.trim()) || randomRoom();
  els.roomInput.value = room;
  const url = new URL(location.href);
  url.searchParams.set('room', room);
  try {
    await navigator.clipboard.writeText(url.toString());
    setSetupMessage('Invite link copied. Send the passphrase separately.', false, true);
  } catch {
    setSetupMessage(`Invite: ${url.toString()}`);
  }
}

els.newRoomBtn.addEventListener('click', () => {
  els.roomInput.value = randomRoom();
  setSetupMessage('New room code generated.', false, true);
});
els.showPasswordBtn.addEventListener('click', () => {
  const showing = els.passwordInput.type === 'text';
  els.passwordInput.type = showing ? 'password' : 'text';
  els.showPasswordBtn.setAttribute('aria-label', showing ? 'Show passphrase' : 'Hide passphrase');
  els.showPasswordBtn.title = showing ? 'Show passphrase' : 'Hide passphrase';
});
els.roomInput.addEventListener('input', () => { els.roomInput.value = normalizeRoom(els.roomInput.value); });
els.joinBtn.addEventListener('click', joinCall);
els.copyBtn.addEventListener('click', copyInvite);
els.muteBtn.addEventListener('click', toggleMute);
els.cameraBtn.addEventListener('click', toggleCamera);
els.fullscreenBtn.addEventListener('click', toggleFullscreen);
els.leaveBtn.addEventListener('click', leaveCall);
window.addEventListener('beforeunload', () => { intentionalClose = true; socket?.close(); });

const initialRoom = new URL(location.href).searchParams.get('room');
els.roomInput.value = initialRoom ? normalizeRoom(initialRoom) : randomRoom();
updateQualityLabel();
