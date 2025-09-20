import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Respond to BOTH POST and GET so tests work either way
const handleVoice = (req, res) => {
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">Hello Tina. Your AI receptionist is alive.</Say>
    </Response>
  `;
  res.type("text/xml").send(twiml);
};

app.post("/twilio/voice", handleVoice);
app.get("/twilio/voice", handleVoice); // handy for browser test
app.get("/", (_req, res) => res.send("OK"));

// Render gives PORT; default to 10000 for local
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
