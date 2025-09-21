// server.js  — Twilio <-> OpenAI Realtime full-duplex bridge
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { randomUUID } from "node:crypto";

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set in Render
const OPENAI_MODEL  = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";
// Assistant persona
const SYSTEM_PROMPT = `You are a friendly, concise UK receptionist for Ironclad Partners.
Keep replies natural and short (under 10 seconds). Clarify if needed.
British English tone.`;
// ====================

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 1) Twilio hits this when a call starts. We start a bidirectional media stream.
app.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.headers.host}/twilio/media"/>
  </Start>
</Response>`;
  res.type("text/xml").send(twiml);
});

// 2) WebSocket endpoint that Twilio connects to
const wss = new WebSocketServer({ noServer: true });

// We’ll upgrade only /twilio/media to WS
const server = app.listen(process.env.PORT || 10000, () =>
  console.log("Server running on port", server.address().port)
);

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, `http://${req.headers.host}`).pathname === "/twilio/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ---- helpers: spawn ffmpeg to transcode between formats ----
// Twilio sends 8k μ-law (pcmu). OpenAI Realtime commonly prefers 16k PCM (s16le).
// We build two pipes:
//  - inTranscoder: 8k μ-law  -> 16k s16le
//  - outTranscoder: 16k s16le -> 8k μ-law
function createInTranscoder() {
  // stdin: μ-law 8k; stdout: 16k s16le mono
  return spawn(ffmpegPath, [
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "pipe:1",
    "-loglevel", "quiet"
  ], { stdio: ["pipe", "pipe", "ignore"] });
}

function createOutTranscoder() {
  // stdin: 16k s16le mono; stdout: μ-law 8k
  return spawn(ffmpegPath, [
    "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0",
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1",
    "-loglevel", "quiet"
  ], { stdio: ["pipe", "pipe", "ignore"] });
}

// ---- The core bridge per-call ----
wss.on("connection", async (twilioWS) => {
  console.log("Twilio media stream connected");

  // 1) Connect to OpenAI Realtime over WebSocket
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`;
  const oaWS = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // per-call transcoders
  const inTrans = createInTranscoder();
  const outTrans = createOutTranscoder();

  // Pipe transcoded audio INTO OpenAI as binary “input_audio_buffer.append”
  inTrans.stdout.on("data", (pcm16) => {
    // Send as an audio-chunk event to Realtime
    // (binary frames are supported as input_audio_buffer.append)
    oaWS.send(JSON.stringify({ type: "input_audio_buffer.append" }));
    oaWS.send(pcm16); // raw 16k mono PCM16
  });

  // When we get PCM16 back from OpenAI, transcode to μ-law and push to Twilio
  outTrans.stdout.on("data", (mulaw8k) => {
    const b64 = mulaw8k.toString("base64");
    twilioWS.send(JSON.stringify({
      event: "media",
      streamSid: currentStreamSid,
      media: { payload: b64 }
    }));
  });

  let currentStreamSid = null;

  // When OpenAI is open, send an initial session config & a start response
  oaWS.on("open", () => {
    console.log("Connected to OpenAI Realtime");
    // Configure expected formats
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        input_audio_format: { type: "pcm16", sample_rate: 16000 },
        output_audio_format: { type: "pcm16", sample_rate: 16000 }
      }
    }));
    // Start generating an initial “hello” response (optional)
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet the caller and ask how you can help." }
    }));
  });

  // Handle OpenAI events/audio
  oaWS.on("message", (data, isBinary) => {
    if (!isBinary) {
      // JSON control event
      try {
        const msg = JSON.parse(data.toString());
        // Realtime may send audio chunks as base64 in “output_audio.delta”
        if (msg.type === "output_audio.delta" && msg.audio) {
          const pcm16 = Buffer.from(msg.audio, "base64");
          outTrans.stdin.write(pcm16);
        }
        // “output_audio.end” means utterance finished.
      } catch { /* ignore */ }
      return;
    }
    // Some SDKs emit raw audio frames as binary; pass to transcoder
    outTrans.stdin.write(data);
  });

  // Receive audio & control from Twilio
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case "start":
        currentStreamSid = msg.start.streamSid;
        console.log("Twilio stream started:", currentStreamSid);
        break;

      case "media": {
        // Twilio sends μ-law 8k base64 payload
        const mulaw = Buffer.from(msg.media.payload, "base64");
        inTrans.stdin.write(mulaw);
        break;
      }

      case "stop":
        console.log("Twilio stream stopped");
        twilioWS.close();
        break;
    }
  });

  const cleanup = () => {
    try { inTrans.stdin.end(); } catch {}
    try { outTrans.stdin.end(); } catch {}
    try { oaWS.close(); } catch {}
    try { twilioWS.close(); } catch {}
  };

  twilioWS.on("close", cleanup);
  oaWS.on("close", cleanup);
  twilioWS.on("error", cleanup);
  oaWS.on("error", cleanup);
});

// Health
app.get("/", (_, res) => res.send("OK"));
