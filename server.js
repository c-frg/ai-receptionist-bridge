import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { xml } from "xmlbuilder2";

// Render will provide PORT; we’ll use it.
const { OPENAI_API_KEY = "", PORT = 10000 } = process.env;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook: return TwiML that starts a media stream to our WS
app.post("/twilio/voice", (req, res) => {
  const doc = xml({ version: "1.0", encoding: "UTF-8" })
    .ele("Response")
      .ele("Start")
        .ele("Stream", { url: `wss://${req.headers.host}/twilio/media` }).up()
      .up()
      .ele("Pause", { length: "600" }).up()
    .up();
  res.type("text/xml").send(doc.end());
});

// WebSocket endpoint — Twilio streams audio here (scaffold for now)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/media" });

wss.on("connection", (twilioWS) => {
  console.log("Twilio media stream connected");
  // Next step (later): open WS to OpenAI Realtime and relay audio
  twilioWS.on("message", () => {});
  twilioWS.on("close", () => console.log("Twilio media stream closed"));
});

server.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});
