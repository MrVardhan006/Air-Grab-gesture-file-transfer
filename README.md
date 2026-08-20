# Air Grab — gesture file transfer (Huawei-style "grab & drop")

Transfer files between **any** two devices with a browser and a camera —
phone, laptop, tablet, doesn't matter what OS — by closing your hand into a
fist to "grab" a file, then opening your hand near another device to "drop"
it there. No app install: it's just a website.

It also has a **watch-together mode**: once you grant screen access (one
click), a fist starts live-mirroring your screen to the other device — so if
you're watching a YouTube video, making a fist streams that same video feed
to whoever's paired with you in real time. Opening your palm pauses it.

> **Why the one click for screen share?** Browsers only allow screen capture
> to start from a genuine user click/tap — a webcam-detected gesture doesn't
> count as "real" user activation for security reasons (otherwise any site
> could silently start capturing your screen). So you grant access once by
> clicking a button, and from then on your gestures just start/pause the
> already-granted stream, which browsers do allow without a fresh click.

## How it works

- **Gesture detection** runs in the browser using [MediaPipe Hands](https://developers.google.com/mediapipe)
  on your webcam feed — nothing is uploaded for this part, it's fully local.
- **Pairing** happens through a tiny signaling server: type the same "room
  code" on two devices and they find each other.
- **The actual file transfer** goes peer-to-peer over a **WebRTC data
  channel** — the server only relays small handshake messages, never the
  file bytes.

## Publishing with Streamlit

Streamlit is Python-only, so it can't host `server.js` (the Node/WebSocket
signaling server) directly. The split that works:

1. **Deploy `server.js` somewhere that runs Node** — Render, Railway, or
   Fly.io all have a free tier that's plenty for this. Push this whole
   folder, set the start command to `npm start`, and note the URL it gives
   you (e.g. `your-app.onrender.com`). Your signaling URL is that host with
   `wss://` in front: `wss://your-app.onrender.com`.
2. **Deploy `streamlit_app.py` to Streamlit Community Cloud** (or run
   `streamlit run streamlit_app.py` locally). It serves the camera/gesture/
   WebRTC client and just needs that signaling URL pasted into the text box
   at the top of the page — it connects out to your Node service from there.

Locally, that's:
```bash
# terminal 1 — signaling server
npm install && npm start

# terminal 2 — Streamlit front-end
pip install -r requirements.txt
streamlit run streamlit_app.py
```
and enter `ws://localhost:3000` in the signaling-URL box.

> **Heads up on iframes:** Streamlit embeds custom HTML inside an iframe,
> and camera/screen-share permissions inside nested iframes are occasionally
> inconsistent across browsers. If a device doesn't get prompted for camera
> access, the reliable fallback is hosting `public/` as a plain static site
> (Netlify, Vercel, GitHub Pages, or just `server.js`'s own Express server)
> and opening that directly in a full tab — no iframe involved.

## Run it without Streamlit

```bash
npm install
npm start
```

This starts the server on `http://localhost:3000`.

### Testing on one machine
Open `http://localhost:3000` in two browser tabs, use the same room code,
different device names.

### Testing on two real devices (phone + laptop)
Browsers only allow camera access on `https://` or `localhost` — so for two
separate devices you need either:

- **Same Wi-Fi + a tunnel** (easiest): run `npx ngrok http 3000` in another
  terminal, then open the `https://...ngrok...` URL on both devices.
- **Deploy it** to any Node host (Render, Railway, Fly.io, a VPS) which
  gives you HTTPS automatically.

On each device: open the URL → allow camera access → enter the same room
code → pick a file → close your hand into a fist to grab it → on the other
device, open your hand to catch it (a save link appears).

## Known limitations (and how you'd extend this)

- **No TURN server**: the WebRTC connection uses a public STUN server, which
  works on the same Wi-Fi or most home networks, but can fail across strict
  corporate/mobile networks. Add a TURN server (e.g. via Twilio, or your own
  coturn instance) in `app.js`'s `iceServers` array for reliability anywhere.
- **Files, not raw screen grabs**: browsers can't let a webpage reach into
  the OS and "screenshot whatever's under your hand" the way Huawei's native
  OS feature can. Instead, you pick a file first, then use the fist gesture
  to trigger sending it — the gesture is the "send" trigger rather than a
  literal grab of arbitrary screen content.
- **Gesture accuracy**: the open/fist classifier is a simple heuristic
  (counts curled fingers by comparing landmark distances to the wrist). It's
  good enough for a demo; a production version would want a trained gesture
  classifier or MediaPipe's Gesture Recognizer task for higher accuracy and
  extra gestures (pinch, swipe, etc.).
- **Room size**: currently pairs 2 devices per room; the server already
  supports N devices per room if you want to broadcast one grab to several
  receivers.
- **Security**: anyone who knows your room code can join — fine for a demo,
  but add a PIN/expiring code and TLS-only deployment before using this for
  anything sensitive.

## File structure

```
gesture-transfer/
├── server.js           # WebSocket signaling server (pairing + WebRTC relay)
├── streamlit_app.py     # Streamlit wrapper that serves the client, pointing at server.js
├── requirements.txt      # Python deps for streamlit_app.py
├── package.json
└── public/
    ├── index.html       # UI shell
    ├── style.css
    └── app.js            # pairing, WebRTC, MediaPipe gesture detection, file chunking
```
