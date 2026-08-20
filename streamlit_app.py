"""
Air Grab — Streamlit front-end

Streamlit can't run the Node/WebSocket signaling server (Streamlit apps are
Python-only), so this app just serves the browser client — camera capture,
MediaPipe gesture detection, and the WebRTC file/screen transfer — and
connects out to wherever you've deployed `server.js` separately (Render,
Railway, Fly.io, a VPS, etc. — anything that gives you a wss:// URL).

Deploy this file to Streamlit Community Cloud (or `streamlit run` locally)
alongside the rest of this project.
"""

import json
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(page_title="Air Grab", page_icon="🖐️", layout="centered")

BASE_DIR = Path(__file__).parent

st.title("🖐️ Air Grab")
st.caption("Grab a file — or your live screen — with a fist. Drop it on another device.")

signaling_url = st.text_input(
    "Signaling server URL",
    placeholder="wss://your-app.onrender.com",
    help=(
        "Air Grab's pairing/handshake server is a small Node.js service "
        "(server.js in this project) — Streamlit can only run Python, so "
        "deploy that piece separately and paste its wss:// URL here. "
        "Everything below then connects to it."
    ),
)

if not signaling_url:
    st.info(
        "Enter your signaling server's URL above to continue. "
        "See the README for a 2-minute deploy guide (Render/Railway free tier works fine)."
    )
    st.stop()

if not signaling_url.startswith(("ws://", "wss://")):
    st.warning("That doesn't look like a WebSocket URL — it should start with `ws://` or `wss://`.")

html = (BASE_DIR / "index.html").read_text()
css = (BASE_DIR / "style.css").read_text()
js = (BASE_DIR / "app.js").read_text()

# Strip the external <link>/<script src> tags from index.html and inline
# everything into one document — simplest way to embed via components.html.
body = html.split("<body>", 1)[1].split("</body>", 1)[0]
body = "\n".join(
    line for line in body.splitlines()
    if "style.css" not in line and 'src="app.js"' not in line
)

embedded_page = f"""
<style>{css}</style>
{body}
<!-- MediaPipe Hands for gesture detection -->
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js" crossorigin="anonymous"></script>
<script>
  window.SIGNALING_SERVER_URL = {json.dumps(signaling_url)};
</script>
<script>
{js}
</script>
"""

components.html(embedded_page, height=1000, scrolling=True)

st.divider()
st.caption(
    "Camera and screen-share permissions can be flaky inside a nested iframe on some browsers. "
    "If yours doesn't prompt for access, host `public/` as a plain static site instead and open it "
    "directly (see README) — Streamlit here is just a convenient wrapper."
)
