import express from "express";
import bodyParser from "body-parser";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT || 10000;
const OPENAI_MODEL = "gpt-4o-realtime-preview-2024-12";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Twilio will POST here to start the call and open a media stream websocket.
app.post("/twilio/voice", (req, res) => {
  const wsUrl = `wss://${req.headers["x-forwarded-host"] || req.headers.host}/media-stream`;
  const twiml = `
    <Response>
      <Say voice="alice">Connecting you to our assistant.</Say>
      <Start>
        <Stream url="${wsUrl}" />
      </Start>
    </Response>`;
  res.type("text/xml").send(twiml.trim());
});

// Minimal ws router
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const wss = new WebSocketServer({ server, path: "/media-stream" });

// --- Helpers --------------------------------------------------------------

function sendTwilioMedia(ws, streamSid, base64Payload) {
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64Payload },
    })
  );
}

function sendTwilioMark(ws, streamSid, name) {
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
}

function safeClose(ws, code = 1000, reason = "normal") {
  try { ws.close(code, reason); } catch {}
}

// --- Media stream bridge --------------------------------------------------

wss.on("connection", (twilioWs) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let openaiWs = null;
  let bufferedFrames = 0; // in ms, Twilio frames are ~20ms each
  let commitTimer = null;

  // Connect to OpenAI Realtime
  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    // Configure formats + server VAD so the model replies automatically
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // 8kHz sample rate for telephony
          input_audio_sample_rate_hz: 8000,
          output_audio_sample_rate_hz: 8000,
          // Server-side voice activity detection (auto turn-taking)
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 200,
            silence_duration_ms: 800,
          },
          // Optional: initial system prompt and voice
          instructions:
            "You are a friendly, concise AI receptionist. Greet callers, gather their name, reason for calling, and contact number. Offer to take a message or route appropriately. Be brief and natural.",
          voice: "verse",
        },
      })
    );
  });

  openaiWs.on("message", (raw) => {
    // Realtime sends a variety of events; we only need audio deltas to feed back to Twilio.
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // handle audio output: some SDKs emit `response.output_audio.delta`,
    // others `response.audio.delta`; support both.
    if (
      (evt.type === "response.output_audio.delta" && evt.delta) ||
      (evt.type === "response.audio.delta" && evt.audio)
    ) {
      const base64Audio = evt.delta ?? evt.audio;
      if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
        sendTwilioMedia(twilioWs, streamSid, base64Audio);
      }
      return;
    }

    // When OpenAI finishes a chunk/utterance, you can insert a Twilio mark (optional)
    if (evt.type === "response.completed" && streamSid && twilioWs.readyState === WebSocket.OPEN) {
      sendTwilioMark(twilioWs, streamSid, `oa_complete_${Date.now()}`);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log(`OpenAI socket closed: ${code} ${reason}`);
    if (twilioWs.readyState === WebSocket.OPEN) {
      // Let Twilio finish gracefully; it will send "stop" soon after
      try {
        twilioWs.send(JSON.stringify({ event: "stop" }));
      } catch {}
    }
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI ws error:", err);
  });

  // --- Twilio → OpenAI: translate Twilio events into input buffer ops -----
  function commitIfNeeded(force = false) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (force || bufferedFrames >= 100) {
      // Tell OpenAI "we've sent a chunk, start processing"
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      bufferedFrames = 0;
    }
  }

  function scheduleCommit() {
    if (commitTimer) return;
    // Safety: auto-commit if we don’t reach 100ms due to silence
    commitTimer = setTimeout(() => {
      commitIfNeeded(true);
      commitTimer = null;
    }, 250); // commit after 250ms of inactivity
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { event } = msg;

    if (event === "start") {
      streamSid = msg.start?.streamSid;
      console.log(`Twilio stream started: ${streamSid}`);
      return;
    }

    if (event === "media") {
      const payload = msg.media?.payload; // base64 μ-law 8k audio, ~20ms frames
      if (payload && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        // Append audio to OpenAI input buffer
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payload, // keep base64; formats already set to g711_ulaw
          })
        );

        // Track ~20ms per media frame
        bufferedFrames += 20;

        // Commit when we have >=100ms buffered (avoids "buffer too small")
        if (bufferedFrames >= 100) {
          commitIfNeeded(true);
        } else {
          scheduleCommit();
        }
      }
      return;
    }

    if (event === "mark") {
      // ignore or map to OA markers if needed
      return;
    }

    if (event === "stop") {
      console.log(`Twilio stream stopped: ${streamSid}`);
      try {
        commitIfNeeded(true); // flush any remaining audio
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
  });

  twilioWs.on("close", () => {
    console.log("Twilio ws closed");
    clearTimeout(commitTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeClose(openaiWs, 1000, "twilio_ws_closed");
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio ws error:", err);
    clearTimeout(commitTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      safeClose(openaiWs, 1011, "twilio_ws_error");
    }
  });
});
