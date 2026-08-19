LINKLINE — FULL CLEAN LOW-LATENCY BUILD

FILES
- index.html
- style.css
- app.js
- audio-worklet.js
- vercel.json
- package.json
- server.js

WHAT CHANGED
- Same simple camera + microphone call experience
- No screen sharing
- No Picture-in-Picture code
- No captureStream
- No trackers
- No redirects
- Starts at 540p / 20 fps
- Lower video bitrate
- Drops stale video rather than building a large backlog
- 24 kHz microphone transport
- Small capped audio jitter buffer
- Vercel is explicitly configured as a static frontend
- Render remains the WebSocket relay backend

VERCEL
Upload the whole folder/repo.
Framework preset: Other.
The included vercel.json serves the frontend as static files.

RENDER
The included package.json starts server.js with:
  npm start

Current frontend app.js expects:
  wss://test-ig-7tjb.onrender.com/api/ws

If you create a NEW Render service in another region, its hostname will change.
After the new service is live, replace that one WebSocket URL in app.js with:
  wss://YOUR-NEW-RENDER-HOST/api/ws

REGION NOTE
A geographic midpoint is not always the lowest-latency network path.
Measure actual RTT from both devices before deciding which region is best.

IMPORTANT
Both callers should fully reload after deployment because audio transport changed.

This build is not designed to bypass or disguise itself from managed-network filtering.
If a managed network blocks the site, use the network's normal approval/allowlisting process.
