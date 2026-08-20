// app.js
// Three jobs happening here:
//  1. Pairing: join a "room" on the signaling server so devices can find each other.
//  2. WebRTC: once paired, open a direct peer-to-peer data channel (the server never sees file bytes).
//  3. Gestures: use MediaPipe Hands on the webcam feed to detect "grab" (fist) and "release" (open palm),
//     and drive the send/receive flow from those gestures.

const CHUNK_SIZE = 16 * 1024; // 16KB per data-channel message

// ---------- DOM ----------
const pairingScreen = document.getElementById('pairing-screen');
const gestureScreen = document.getElementById('gesture-screen');
const roomInput = document.getElementById('room-code');
const nameInput = document.getElementById('device-name');
const joinBtn = document.getElementById('join-btn');
const peerStatus = document.getElementById('peer-status');
const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const handStateEl = document.getElementById('hand-state');
const fileInput = document.getElementById('file-input');
const armedFileEl = document.getElementById('armed-file');
const logEl = document.getElementById('transfer-log');
const dot = document.getElementById('connection-dot');
const connLabel = document.getElementById('connection-label');
const screenshareScreen = document.getElementById('screenshare-screen');
const grantScreenBtn = document.getElementById('grant-screen-btn');
const screenshareStatus = document.getElementById('screenshare-status');
const remoteVideo = document.getElementById('remote-video');
const remotePlaceholder = document.getElementById('remote-placeholder');

function log(msg) {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.prepend(line);
}

function setConnected(isConnected, label) {
  dot.classList.toggle('online', isConnected);
  dot.classList.toggle('offline', !isConnected);
  connLabel.textContent = label;
}

// ---------- Signaling (WebSocket) ----------
// Normally the client connects back to whatever host served this page
// (same-origin). But when this page is embedded elsewhere — e.g. inside a
// Streamlit app, which can only run Python and can't host our Node/WebSocket
// signaling server — window.SIGNALING_SERVER_URL can be injected to point
// at wherever that server is actually deployed instead.
let ws;
let deviceName;
let roomCode;
let remotePeerName = 'the other device';

function connectSignaling() {
  const url = window.SIGNALING_SERVER_URL
    ? window.SIGNALING_SERVER_URL
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomCode, deviceName }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        peerStatus.textContent = msg.peers.length
          ? `Connected to room. Already here: ${msg.peers.join(', ')}`
          : 'Waiting for another device to join this room…';
        if (msg.peers.length > 0) remotePeerName = msg.peers[0];
        // If someone was already here, we initiate the WebRTC offer.
        if (msg.peers.length > 0) startPeerConnection(true);
        break;
      case 'peer-joined':
        peerStatus.textContent = `${msg.deviceName} joined. Connecting…`;
        remotePeerName = msg.deviceName;
        // The newcomer initiates; we just wait for their offer.
        if (!pc) startPeerConnection(false);
        break;
      case 'peer-left':
        setConnected(false, `${msg.deviceName} disconnected`);
        break;
      case 'signal':
        handleSignal(msg.data);
        break;
      case 'gesture':
        handleRemoteGesture(msg.gesture, msg.meta);
        break;
    }
  };

  ws.onclose = () => setConnected(false, 'signaling server disconnected');
}

function sendSignal(data) {
  ws.send(JSON.stringify({ type: 'signal', data }));
}

function sendGesture(gesture, meta) {
  ws.send(JSON.stringify({ type: 'gesture', gesture, meta }));
}

// ---------- WebRTC ----------
let pc;
let dataChannel;
let incomingFileMeta = null;
let incomingChunks = [];
let incomingBytesReceived = 0;

function startPeerConnection(isInitiator) {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ kind: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setConnected(true, 'peer connected — ready to transfer');
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setConnected(false, 'peer connection lost');
    }
  };

  // Incoming live screen share from the other device
  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remotePlaceholder.classList.add('hidden');
    screenshareStatus.textContent = `Watching ${remotePeerName}'s screen live.`;
  };

  // Whenever tracks are added/removed (e.g. we grant screen access), renegotiate automatically
  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ kind: 'offer', sdp: offer });
    } catch (err) {
      log('Renegotiation failed: ' + err.message);
    }
  };

  // If we already have a granted screen stream waiting, attach it now (starts paused/disabled)
  if (pendingScreenStream) {
    for (const track of pendingScreenStream.getTracks()) {
      track.enabled = false;
      pc.addTrack(track, pendingScreenStream);
    }
  }

  if (isInitiator) {
    dataChannel = pc.createDataChannel('files');
    wireDataChannel();
    // Creating the data channel (and, later, adding screen-share tracks)
    // automatically fires onnegotiationneeded, which sends the offer —
    // no manual createOffer() here, to avoid a duplicate/racing offer.
  } else {
    pc.ondatachannel = (e) => {
      dataChannel = e.channel;
      wireDataChannel();
    };
  }
}

function wireDataChannel() {
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.onopen = () => setConnected(true, 'peer connected — ready to transfer');
  dataChannel.onmessage = (e) => handleIncomingChunk(e.data);
}

async function handleSignal(data) {
  if (!pc) startPeerConnection(false);

  if (data.kind === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ kind: 'answer', sdp: answer });
  } else if (data.kind === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.kind === 'ice') {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      /* benign if it arrives before remote description */
    }
  }
}

// ---------- Live screen mirror ("watch together") ----------
// Browsers require a real click to start screen capture — a webcam-detected
// gesture doesn't count as user activation. So: click once to grant access,
// then the fist/open-palm gestures just enable/disable the already-granted
// track, which IS allowed without a fresh click.
//
// Platform reality check: getDisplayMedia (screen capture) is a desktop-only
// web API — iOS Safari and Android Chrome don't implement it at all, on any
// browser, as of 2026. That's an Apple/Google platform restriction, not
// something fixable from here. Phones can still *receive* a shared screen
// (playing video works everywhere) — they just can't be the one sharing.
let pendingScreenStream = null;
let screenSharingActive = false;

const screenShareSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
if (!screenShareSupported) {
  grantScreenBtn.disabled = true;
  grantScreenBtn.textContent = '🖥️ Screen share not available on this device';
  screenshareStatus.textContent =
    'Mobile browsers (iOS Safari, Android Chrome) don\u2019t support sharing your screen — ' +
    'that\u2019s an OS/browser restriction, not a bug here. You can still receive a shared screen from a desktop, ' +
    'and file grab/drop works fully on this device.';
}

grantScreenBtn.addEventListener('click', async () => {
  if (!screenShareSupported) return;
  try {
    pendingScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    screenshareStatus.textContent = 'Access granted — make a fist to start sharing, open your hand to pause.';

    // If we already have a peer connection, attach now (starts disabled/paused)
    if (pc) {
      for (const track of pendingScreenStream.getTracks()) {
        track.enabled = false;
        pc.addTrack(track, pendingScreenStream);
      }
    }

    // If the user stops sharing from the browser's own "Stop sharing" bar
    pendingScreenStream.getVideoTracks()[0].onended = () => {
      screenSharingActive = false;
      screenshareStatus.textContent = 'Screen access ended. Click above to grant again.';
      pendingScreenStream = null;
    };
  } catch (err) {
    screenshareStatus.textContent = 'Screen access was not granted.';
  }
});

function setScreenSharing(active) {
  if (!pendingScreenStream) return;
  screenSharingActive = active;
  for (const track of pendingScreenStream.getTracks()) {
    track.enabled = active;
  }
  screenshareStatus.textContent = active
    ? 'Live — sharing your screen now.'
    : 'Paused — open granted, not currently sharing.';
}

// ---------- File transfer over the data channel ----------
let armedFile = null;

fileInput.addEventListener('change', () => {
  armedFile = fileInput.files[0] || null;
  armedFileEl.textContent = armedFile
    ? `Armed: ${armedFile.name} (${(armedFile.size / 1024).toFixed(0)} KB) — now make a fist to grab it`
    : 'No file armed yet';
});

function sendArmedFile() {
  if (!armedFile) {
    log('Made a fist, but no file is armed — choose a file first.');
    return;
  }
  if (!dataChannel || dataChannel.readyState !== 'open') {
    log('Grabbed, but no connected device to drop it on yet.');
    return;
  }

  const file = armedFile;
  log(`Grabbed "${file.name}" — sending to ${remotePeerName}. Have them open their hand to catch it.`);

  // Announce the incoming file so the receiving device knows what to expect
  dataChannel.send(JSON.stringify({ kind: 'meta', name: file.name, size: file.size, mime: file.type }));

  const reader = new FileReader();
  let offset = 0;

  reader.onload = () => {
    dataChannel.send(reader.result);
    offset += reader.result.byteLength;
    if (offset < file.size) {
      readSlice(offset);
    } else {
      dataChannel.send(JSON.stringify({ kind: 'end' }));
      log(`Finished sending "${file.name}".`);
    }
  };

  function readSlice(o) {
    const slice = file.slice(o, o + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  }

  readSlice(0);
}

function handleIncomingChunk(data) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.kind === 'meta') {
      incomingFileMeta = msg;
      incomingChunks = [];
      incomingBytesReceived = 0;
      log(`Incoming file from ${remotePeerName}: "${msg.name}" (${(msg.size / 1024).toFixed(0)} KB) — open your hand to catch it.`);
    } else if (msg.kind === 'end') {
      finishIncomingFile();
    }
    return;
  }
  // binary chunk
  incomingChunks.push(data);
  incomingBytesReceived += data.byteLength;
}

function finishIncomingFile() {
  if (!incomingFileMeta) return;
  const blob = new Blob(incomingChunks, { type: incomingFileMeta.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = incomingFileMeta.name;
  a.textContent = `⬇ Save "${incomingFileMeta.name}"`;
  a.style.display = 'block';
  logEl.prepend(a);
  log(`Caught "${incomingFileMeta.name}" — tap the link above to save it.`);
  incomingFileMeta = null;
  incomingChunks = [];
}

// ---------- Gesture events shared with the other device (for UI feedback only) ----------
function handleRemoteGesture(gesture, meta) {
  if (gesture === 'grab') log(`Other device grabbed a file. Open your hand to catch it.`);
}

// ---------- Join flow ----------
joinBtn.addEventListener('click', async () => {
  roomCode = roomInput.value.trim();
  deviceName = nameInput.value.trim() || 'Unnamed device';
  if (!roomCode) {
    roomInput.focus();
    return;
  }

  connectSignaling();
  pairingScreen.classList.add('hidden');
  gestureScreen.classList.remove('hidden');
  screenshareScreen.classList.remove('hidden');

  await startCamera();
  startHandTracking();
});

// ---------- Camera + MediaPipe Hands ----------
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await new Promise((resolve) => (video.onloadedmetadata = resolve));
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

// Gesture state machine: OPEN -> FIST triggers "grab". FIST -> OPEN triggers "release".
let lastGestureState = 'unknown'; // 'open' | 'fist' | 'unknown'
let stateStableFrames = 0;
const STABLE_FRAMES_NEEDED = 4; // debounce so a blurry frame doesn't misfire

function classifyHand(landmarks) {
  // Landmarks: 0=wrist, tips: 4(thumb) 8(index) 12(middle) 16(ring) 20(pinky)
  // PIP joints: 6(index) 10(middle) 14(ring) 18(pinky)
  // A finger counts as "curled" if its tip is closer to the wrist than its PIP joint is.
  const wrist = landmarks[0];
  const fingers = [
    { tip: 8, pip: 6 },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 },
  ];

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let curledCount = 0;
  for (const f of fingers) {
    const tipDist = dist(landmarks[f.tip], wrist);
    const pipDist = dist(landmarks[f.pip], wrist);
    if (tipDist < pipDist) curledCount++;
  }

  if (curledCount >= 3) return 'fist';
  if (curledCount <= 1) return 'open';
  return 'unknown';
}

function startHandTracking() {
  const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  hands.onResults(onHandResults);

  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: 480,
    height: 360,
  });
  camera.start();
}

function onHandResults(results) {
  overlayCtx.save();
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    handStateEl.textContent = 'watching for your hand…';
    handStateEl.className = 'hand-state';
    overlayCtx.restore();
    return;
  }

  const landmarks = results.multiHandLandmarks[0];
  drawConnectors(overlayCtx, landmarks, Hands.HAND_CONNECTIONS, { color: '#5b7cff', lineWidth: 2 });
  drawLandmarks(overlayCtx, landmarks, { color: '#eef1f8', radius: 2 });

  const gesture = classifyHand(landmarks);

  if (gesture === lastGestureState) {
    stateStableFrames++;
  } else {
    lastGestureState = gesture;
    stateStableFrames = 0;
  }

  if (gesture === 'fist') {
    handStateEl.textContent = '✊ fist';
    handStateEl.className = 'hand-state grabbed';
  } else if (gesture === 'open') {
    handStateEl.textContent = '🖐️ open palm';
    handStateEl.className = 'hand-state released';
  } else {
    handStateEl.textContent = 'watching for your hand…';
    handStateEl.className = 'hand-state';
  }

  // Fire the transition exactly once it's been stable for a few frames
  if (stateStableFrames === STABLE_FRAMES_NEEDED) {
    if (gesture === 'fist') {
      sendGesture('grab', armedFile ? { name: armedFile.name } : null);
      sendArmedFile();       // one-shot: sends the currently armed file, if any
      setScreenSharing(true); // continuous: starts/resumes the live screen mirror, if granted
    } else if (gesture === 'open') {
      setScreenSharing(false); // pause the live screen mirror
    }
  }

  overlayCtx.restore();
}
