// server.js — Twilio <-> OpenAI Realtime full-duplex bridge (copy/paste)

// Imports
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

// ===== Config =====
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
const SYSTEM_PROMPT = `You are a friendly, concise UK receptionist for Ironclad Partners.
Use British English. Keep replies natural and under 10 seconds.
Confirm name and callback number if not clear. Offer to book if relevant.`;
// ===================

// App
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Twilio webhook returns TwiML to start media stream ----------
app.post("/twilio/voice", (req, res) => {
  // Use explicit host to avoid any proxy header weirdness
  const host = "ai-receptionist-bridge-ax4v.onrender.com";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to our assistant.</Say>
  <Start>
    <Stream url="wss://${host}/twilio/media"/>
  </Start>
  <!-- Keep call open while streaming -->
  <Pause length="600"/>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Health
app.get("/", (_req, res) => res.send("OK"));

// ---------- WebSocket server for Twilio Media Streams ----------
const wss = new WebSocketServer({ noServer: true });

const server = app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/twilio/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ---------- Transcoder helpers (ffmpeg) ----------
// Twilio sends μ-law 8k; OpenAI expects PCM16 16k. We transcode both directions.
function createInTranscoder() {
  // stdin: μ-law 8k  -> stdout: PCM16 16k mono
  return spawn(ffmpegPath, [
    "-f","mulaw","-ar","8000","-ac","1","-i","pipe:0",
    "-f","s16le","-ar","16000","-ac","1","pipe:1",
    "-loglevel","quiet"
  ], { stdio: ["pipe","pipe","ignore"] });
}

function createOutTranscoder() {
  // stdin: PCM16 16k  -> stdout: μ-law 8k mono
  return spawn(ffmpegPath, [
    "-f","s16le","-ar","16000","-ac","1","-i","pipe:0",
    "-f","mulaw","-ar","8000","-ac","1","pipe:1",
    "-loglevel","quiet"
  ], { stdio: ["pipe","pipe","ignore"] });
}

// Optional: 1s tone to prove return path
function playTestTone(outTrans) {
  const tone = spawn(ffmpegPath, [
    "-f","lavfi","-i","sine=frequency=440:sample_rate=16000:duration=1",
    "-f","s16le","-ac","1","pipe:1","-loglevel","quiet"
  ], { stdio: ["ignore","pipe","ignore"] });
  tone.stdout.on("data", (pcm16) => outTrans.stdin.write(pcm16));
}

// ---------- Per-call bridge ----------
wss.on("connection", async (twilioWS) => {
  console.log("Twilio media stream connected");

  // Connect to OpenAI Realtime
  const oaURL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const oaWS = new WebSocket(oaURL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // Per-call transcoders
  const inTrans = createInTranscoder();
  const outTrans = createOutTranscoder();

  // Twilio stream SID (needed when we send audio back)
  let streamSid = null;

  // Push OpenAI PCM16 -> μ-law -> Twilio media events
  outTrans.stdout.on("data", (mulaw8k) => {
    if (!streamSid) return;
    twilioWS.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: mulaw8k.toString("base64") }
    }));
  });

  // Buffer & send caller audio to OpenAI as base64 chunks
  let buf = [];
  let lastCommit = Date.now();

  inTrans.stdout.on("data", (pcm16) => {
    buf.push(pcm16);
    const now = Date.now();

    // send small chunks ~200ms
    if (now - lastCommit > 200) {
      const chunk = Buffer.concat(buf);
      buf = [];

      oaWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")   // base64 PCM16 16k
      }));

      // Commit and request response about every ~900ms
      if (now - lastCommit > 900) {
        oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oaWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio"], instructions: "" }
        }));
        lastCommit = now;
      }
    }
  });

  // ------ OpenAI Realtime control & audio ------
  oaWS.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    // Configure session formats and system prompt
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        input_audio_format:  { type: "pcm16", sample_rate: 16000 },
        output_audio_format: { type: "pcm16", sample_rate: 16000 }
      }
    }));

    // Initial hello
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"], instructions: "Hello! How can I help?" }
    }));

    // Prove return path with a short tone
    playTestTone(outTrans);
  });

  // Handle various preview event names for audio deltas
  oaWS.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

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

  // ------ Twilio media events ------
  twilioWS.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === "start") {
      streamSid = m.start.streamSid;
      console.log("Twilio stream started:", streamSid);
    } else if (m.event === "media") {
      // μ-law 8k -> PCM16 16k -> to OpenAI
      const mulaw = Buffer.from(m.media.payload, "base64");
      inTrans.stdin.write(mulaw);
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
