// server.js — Twilio <-> OpenAI Realtime full-duplex bridge with safe buffering

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Your Render host (no trailing slash)
const PUBLIC_HOST = "ai-receptionist-bridge-ax4v.onrender.com";

const SYSTEM_PROMPT = `You are a friendly, concise UK receptionist for Ironclad Partners.
Use British English. Speak naturally. Keep replies under 8–10 seconds.
Confirm name and callback number when unclear. Offer to book where appropriate.`;
// ------------------------------------------------

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook: return TwiML that starts the bidirectional stream.
app.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to our assistant.</Say>
  <Start>
    <Stream url="wss://${PUBLIC_HOST}/twilio/media"/>
  </Start>
  <!-- Keep the call open while the media stream runs -->
  <Pause length="600"/>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Simple health
app.get("/", (_req, res) => res.send("OK"));

const server = app.listen(PORT, () =>
  console.log("Server running on port", PORT)
);

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/twilio/media") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// --------- Transcoders (ffmpeg) ---------
// Twilio: μ-law 8k mono; OpenAI Realtime: PCM16 16k mono

function createInTranscoder() {
  // stdin: mulaw/8k  -> stdout: s16le/16k
  return spawn(ffmpegPath, [
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
    "-loglevel", "quiet"
  ], { stdio: ["pipe", "pipe", "ignore"] });
}

function createOutTranscoder() {
  // stdin: s16le/16k -> stdout: mulaw/8k
  return spawn(ffmpegPath, [
    "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0",
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1",
    "-loglevel", "quiet"
  ], { stdio: ["pipe", "pipe", "ignore"] });
}

// Optional: quick 1s tone to prove Twilio return path works
function playTestTone(outTrans) {
  const tone = spawn(ffmpegPath, [
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
    "-f", "s16le", "-ac", "1", "pipe:1", "-loglevel", "quiet"
  ], { stdio: ["ignore", "pipe", "ignore"] });
  tone.stdout.on("data", (pcm16) => outTrans.stdin.write(pcm16));
}

// -------------- Per-call bridge --------------
wss.on("connection", (twilioWS) => {
  console.log("Twilio media stream connected");

  // Connect to OpenAI Realtime WS
  const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_MODEL
  )}`;
  const oaWS = new WebSocket(oaURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const inTrans = createInTranscoder();
  const outTrans = createOutTranscoder();

  let streamSid = null;
  const OPEN = WebSocket.OPEN;

  // ---- Send OpenAI audio back to Twilio (PCM16 -> μ-law 8k) ----
  outTrans.stdout.on("data", (mulaw8k) => {
    if (!streamSid) return;
    twilioWS.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: mulaw8k.toString("base64") }
    }));
  });

  // ---- Buffering so we never send to OpenAI before WS is open ----
  let oaReady = false;
  let queuedBase64 = [];
  let haveUncommitted = false;

  function appendToOpenAI(base64) {
    if (!oaReady || oaWS.readyState !== OPEN) {
      queuedBase64.push(base64);
      haveUncommitted = true;
      return;
    }
    oaWS.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: base64
    }));
    haveUncommitted = true;
  }

  function flushIfReady() {
    if (!oaReady || oaWS.readyState !== OPEN) return;
    while (queuedBase64.length) {
      const b64 = queuedBase64.shift();
      oaWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: b64
      }));
    }
    if (haveUncommitted) {
      oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      oaWS.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"], instructions: "" }
      }));
      haveUncommitted = false;
    }
  }

  // ---- Caller audio: μ-law 8k -> PCM16 16k -> OpenAI (base64) ----
  let chunkBuf = [];
  let lastFlush = Date.now();

  inTrans.stdout.on("data", (pcm16) => {
    chunkBuf.push(pcm16);
    const now = Date.now();

    if (now - lastFlush > 200) {
      const chunk = Buffer.concat(chunkBuf);
      chunkBuf = [];
      appendToOpenAI(chunk.toString("base64"));

      if (now - lastFlush > 900) {
        flushIfReady();
        lastFlush = now;
      }
    }
  });

  // ---- OpenAI control & audio deltas ----
  oaWS.on("open", () => {
    console.log("Connected to OpenAI Realtime");
    oaReady = true;

    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        input_audio_format:  { type: "pcm16", sample_rate: 16000 },
        output_audio_format: { type: "pcm16", sample_rate: 16000 }
      }
    }));

    // Flush any buffered caller audio, then request first response
    flushIfReady();

    oaWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"], instructions: "Hello! How can I help?" }
    }));

    // (Optional) Beep to prove return audio path
    playTestTone(outTrans);
  });

  oaWS.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Handle various preview names for audio deltas
    if (
      (msg.type === "output_audio.delta" && msg.audio) ||
      (msg.type === "response.output_audio.delta" && msg.audio) ||
      (msg.type === "response.audio.delta" && msg.audio)
    ) {
      const pcm16 = Buffer.from(msg.audio, "base64");
      outTrans.stdin.write(pcm16);
    }

    if (msg.type === "error") {
      console.error("OpenAI error:", msg);
    }
  });

  oaWS.on("close", () => { oaReady = false; queuedBase64 = []; haveUncommitted = false; });
  oaWS.on("error", () => { oaReady = false; });

  // ---- Twilio media events ----
  twilioWS.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      streamSid = m.start.streamSid;
      console.log("Twilio stream started:", streamSid);
    } else if (m.event === "media") {
      const mulaw = Buffer.from(m.media.payload, "base64");
      inTrans.stdin.write(mulaw);
    } else if (m.event === "stop") {
      console.log("Twilio stream stopped");
      cleanup();
    }
  });

  // ---- Cleanup ----
  const cleanup = () => {
    try { inTrans.stdin.end(); } catch {}
    try { outTrans.stdin.end(); } catch {}
    try { oaWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  };

  twilioWS.on("close", cleanup);
  twilioWS.on("error", cleanup);
  oaWS.on("close", cleanup);
  oaWS.on("error", cleanup);
});
