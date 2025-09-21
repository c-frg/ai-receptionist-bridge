import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// One handler we can hit by POST (Twilio) or GET (browser)
function handleVoice(req, res) {
  console.log(`[WEBHOOK] /twilio/voice hit via ${req.method} at ${new Date().toISOString()}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello Tina. Your A I receptionist is alive.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
}

app.post("/twilio/voice", handleVoice);
app.get("/twilio/voice", handleVoice);

// quick health-check
app.get("/", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
