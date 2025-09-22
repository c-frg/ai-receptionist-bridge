// server.js — Twilio <-> OpenAI Realtime bridge with safe buffering & 100ms commit guard

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const PUBLIC_HOST = "ai-receptionist-bridge-ax4v.onrender.com";

const SYSTEM_PROMPT = `You are a friendly, concise UK receptionist for Ironclad Partners.
Use British English. Speak naturally. Keep replies under 8–10 seconds.
Confirm name and callback number when unclear. Offer to book where appropriate.`;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// TwiML: start Twilio <Start><Stream> to our WS endpoint
app.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to our assistant.</Say>
  <Start>
    <Stream url="wss://${PUBLIC_HOST}/twilio/media"/>
  </Start>
  <Pause length="600"/>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/", (_req, res) => res.send("OK"));

const server = app.listen(PORT, () =>
  console.log("Server running on port", PORT)
);

// WS server for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/twilio/media") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// ---------- Transcoders ----------
function createInTranscoder() {
  // Twilio μ-law 8k mono -> PCM16 16k mono
  return spawn(ffmpegPath, [
    "-f","mulaw","-ar","8000","-ac","1","-i","pipe:0",
    "-f","s16le","-ar","16000","-ac","1","pipe:1",
    "-loglevel","quiet"
  ], { stdio: ["pipe","pipe","ignore"] });
}

function createOutTranscoder() {
  // PCM16 16k mono -> Twilio μ-law 8k mono
  return spawn(ffmpegPath, [
    "-f","s16le","-ar","16000","-ac","1","-i","pipe:0",
    "-f","mulaw","-ar","8000","-ac","1","pipe:1",
    "-loglevel","quiet"
  ], { stdio: ["pipe","pipe","ignore"] });
}

// ---------- Per-call bridge ----------
wss.on("connection", (twilioWS) => {
  console.log("Twilio media stream connected");

  const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const oaWS = new WebSocket(oaURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  const inTrans = createInTranscoder();
  const outTrans = createOutTranscoder();
  const OPEN = WebSocket.OPEN;

  let streamSid = null;

  // Send OpenAI audio back to Twilio (PCM16 -> μ-law 8k)
  outTrans.stdout.on("data", (mulaw8k) => {
    if (!streamSid) return;
    twilioWS.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: mulaw8k.toString("base64") }
    }));
  });

  // ---- Safe buffering & 100ms commit guard ----
  let oaReady = false;
  let queuedBase64 = [];
  let bytesSinceCommit = 0; // PCM16 bytes since last commit

  // constants for 100ms @ 16kHz, 16-bit mono
  const PCM_BYTES_PER_MS = (16000 * 2) / 1000; // 32 bytes per ms
  const MIN_COMMIT_MS = 120;                   // commit only when >= 120ms (a bit above the 100ms min)
  const MIN_COMMIT_BYTES = Math.ceil(PCM_BYTES_PER_MS * MIN_COMMIT_MS);

  function appendToOpenAI(base64Chunk) {
    // accumulate size in PCM16 bytes
    const pcmBytes = Buffer.from(base64Chunk, "base64").length;
    bytesSinceCommit += pcmBytes;

    // buffer until socket is OPEN
    if (!oaReady || oaWS.readyState !== OPEN) {
      queuedBase64.push(base64Chunk);
      return;
    }
    oaWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Chunk }));
  }

  function flushIfReady(force = false) {
    if (!oaReady || oaWS.readyState !== OPEN) return;
    // Flush queued chunks first
    while (queuedBase64.length) {
      const b64 = queuedBase64.shift();
      oaWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }
    // Only commit if we truly have >= 120ms (or force when we KNOW bytesSinceCommit>0 and want a response)
    if ((bytesSinceCommit >= MIN_COMMIT_BYTES) || (force && bytesSinceCommit > 0)) {
      oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      oaWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"], instructions: "" } }));
      bytesSinceCommit = 0;
    }
  }

  // Caller audio: μ-law 8k -> PCM16 16k (via ffmpeg) -> Append as base64
  let frameBuf = [];
  let lastFlushTs = Date.now();

  inTrans.stdout.on("data", (pcm16) => {
    frameBuf.push(pcm16);
    const now = Date.now();

    // Append roughly every 200ms of PCM
    if (now - lastFlushTs > 200) {
      const chunk = Buffer.concat(frameBuf);
      frameBuf = [];
      if (chunk.length) {
        appendToOpenAI(chunk.toString("base64"));
      }
      // Try a commit roughly every ~900ms, respecting the 120ms minimum
      if (now - lastFlushTs > 900) {
        flushIfReady();
        lastFlushTs = now;
      }
    }
  });

  // ---- OpenAI WS lifecycle ----
  oaWS.on("open", () => {
    console.log("Connected to OpenAI Realtime");
    oaReady = true;

    // IMPORTANT: strings, not objects
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16"
      }
    }));

    // Don’t commit yet if we have no audio; just prime a greeting
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"], instructions: "Hello! How can I help?" }
    }));
  });

  oaWS.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Audio deltas (names differ across preview releases)
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

  oaWS.on("close", () => { oaReady = false; queuedBase64 = []; bytesSinceCommit = 0; });
  oaWS.on("error", () => { oaReady = false; });

  // ---- Twilio media events ----
  twilioWS.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      streamSid = m.start.streamSid;
      console.log("Twilio stream started:", streamSid);
    } else if (m.event === "media") {
      const mulaw8k = Buffer.from(m.media.payload, "base64");
      inTrans.stdin.write(mulaw8k);
    } else if (m.event === "stop") {
      console.log("Twilio stream stopped");
      cleanup();
    }
  });

  // Cleanup
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
