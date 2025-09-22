import express from "express";
import bodyParser from "body-parser";
import { WebSocket, WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_MODEL = "gpt-4o-realtime-preview-2024-12";

const app = express();
app.enable("trust proxy"); // respect x-forwarded-* from Render
app.use(bodyParser.urlencoded({ extended: false }));

// --- TwiML: point Twilio to our public WS
app.post("/twilio/voice", (req, res) => {
  const host =
    process.env.PUBLIC_HOST || // e.g. ai-receptionist-bridge-ax4v.onrender.com
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `
<Response>
  <Say voice="alice">Connecting you to our assistant.</Say>
  <Start>
    <Stream url="${wsUrl}" />
  </Start>
</Response>`.trim();

  res.type("text/xml").send(twiml);
});

// Single HTTP server + WS route
const server = app.listen(PORT, () => {
  console.log(`HTTP listening on ${PORT}`);
});
const wss = new WebSocketServer({
  server,
  path: "/media-stream",
  // Twilio doesn’t need compression and this reduces latency:
  perMessageDeflate: false,
});

// Helpers
function twilioSendMedia(ws, streamSid, base64Payload) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64Payload },
    })
  );
}
function twilioSendMark(ws, streamSid, name) {
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
}
function safeClose(ws, code = 1000, reason = "normal") {
  try {
    ws.close(code, reason);
  } catch {}
}

// Bridge
wss.on("connection", (twilioWs) => {
  console.log("[TWI] connected");
  let streamSid = null;
  let openaiWs = null;
  let bufferedMs = 0;
  let commitTimer = null;

  // Connect to OpenAI Realtime
  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
      // Lower latency; Twilio frames are tiny:
      perMessageDeflate: false,
    }
  );

  openaiWs.on("open", () => {
    console.log("[OA] open");
    // Configure formats + server VAD
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          // Telephony codec at 8kHz
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_sample_rate_hz: 8000,
          output_audio_sample_rate_hz: 8000,

          // Automatic turn taking
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 200,
            silence_duration_ms: 700,
          },

          // Keep it short & friendly
          instructions:
            "You are a friendly, concise AI receptionist. Greet the caller immediately, then ask their name and reason for calling. Keep replies brief. If they pause, continue with one clarifying question. Avoid long monologues.",
          voice: "verse",
        },
      })
    );

    // IMPORTANT: Kick off an initial greeting so you hear audio right away
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Hello! Thanks for calling. I’m the receptionist. May I have your name and how I can help today?",
        },
      })
    );
  });

  // Map OpenAI → Twilio audio
  openaiWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Log non-audio event types for debugging (noisy audio omitted)
    if (evt?.type && !String(evt.type).includes("audio")) {
      console.log("[OA evt]", evt.type);
    }

    // Support both event shapes
    const base64Audio =
      (evt.type === "response.output_audio.delta" && evt.delta) ||
      (evt.type === "response.audio.delta" && evt.audio);

    if (base64Audio && streamSid && twilioWs.readyState === WebSocket.OPEN) {
      twilioSendMedia(twilioWs, streamSid, base64Audio);
      return;
    }

    if (evt.type === "response.completed" && streamSid) {
      twilioSendMark(twilioWs, streamSid, `oa_done_${Date.now()}`);
    }
  });

  openaiWs.on("close", (c, r) => console.log("[OA] close", c, r));
  openaiWs.on("error", (e) => console.error("[OA] error", e));

  // Twilio → OpenAI
  function commit(force = false) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (force || bufferedMs >= 100) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      bufferedMs = 0;
    }
  }
  function scheduleCommit() {
    if (commitTimer) return;
    commitTimer = setTimeout(() => {
      commit(true);
      commitTimer = null;
    }, 250);
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const ev = msg.event;

    if (ev === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[TWI] start", streamSid);
      return;
    }

    if (ev === "media") {
      const payload = msg.media?.payload; // base64 μ-law (8kHz), ~20ms/frame
      if (payload && openaiWs.readyState === WebSocket.OPEN) {
        // Append into OA input buffer
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload,
          })
        );
        bufferedMs += 20;

        if (bufferedMs >= 100) {
          commit(true);
        } else {
          scheduleCommit();
        }
      }
      return;
    }

    if (ev === "stop") {
      console.log("[TWI] stop", streamSid);
      try {
        commit(true);
      } finally {
        clearTimeout(commitTimer);
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          safeClose(openaiWs, 1000, "twilio_stop");
        }
        safeClose(twilioWs, 1000, "twilio_stop");
      }
      return;
    }

    if (ev && ev !== "media") {
      // Handy to see oddities like "connected", "mark", etc.
      console.log("[TWI evt]", ev);
    }
  });

  twilioWs.on("close", () => {
    console.log("[TWI] close");
    clearTimeout(commitTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeClose(openaiWs, 1000, "twilio_ws_closed");
    }
  });

  twilioWs.on("error", (e) => {
    console.error("[TWI] error", e);
    clearTimeout(commitTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeClose(openaiWs, 1011, "twilio_ws_error");
    }
  });
});
