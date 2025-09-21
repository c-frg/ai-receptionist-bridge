import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ONE handler we use for both GET (browser test) and POST (Twilio)
function handleVoice(req, res) {
  console.log(`[WEBHOOK] /twilio/voice hit via ${req.method}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello Tina. Your AI receptionist is alive.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
}

app.get("/twilio/voice", handleVoice);   // browser test hits this
app.post("/twilio/voice", handleVoice);  // Twilio will hit this

// health check
app.get("/", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
