import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `You are a warm, concise AI receptionist for Ironclad Partners.
Collect caller name, number, and reason; offer to book. British English tone.
Keep each spoken reply under 10 seconds.`;

// Greets and listens
app.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="en-GB" speechTimeout="auto"
          action="/twilio/handle-speech" method="POST">
    <Say voice="alice">Hi, this is Ironclad’s receptionist. How can I help you today?</Say>
  </Gather>
  <Redirect method="POST">/twilio/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Handles the transcript and replies, then loops
app.post("/twilio/handle-speech", async (req, res) => {
  const said = (req.body.SpeechResult || "").trim();
  console.log("[CALLER SAID]:", said);

  let reply = "Sorry, I didn't catch that. Could you repeat?";
  if (said && OPENAI_API_KEY) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: said }
          ]
        }),
      });
      const data = await r.json();
      reply = data?.choices?.[0]?.message?.content?.trim()
           || "Thanks — could you say that again?";
    } catch (e) {
      console.error("OpenAI error:", e);
      reply = "I had a momentary issue checking details. Please say that again.";
    }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXML(reply)}</Say>
  <Pause length="1"/>
  <Redirect method="POST">/twilio/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Health
app.get("/", (_req, res) => res.send("OK"));

function escapeXML(s=""){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;")
          .replace(/>/g,"&gt;").replace(/\"/g,"&quot;")
          .replace(/'/g,"&apos;");
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
