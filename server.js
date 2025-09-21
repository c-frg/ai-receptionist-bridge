import express from "express";

// ----- CONFIG -----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set in Render
const SYSTEM_PROMPT = `
You are an AI phone receptionist for Ironclad Partners.
Answer warmly, briefly, and take actions like: collecting name/number, reason for call,
and offering to book a slot. If unsure, ask a short follow-up.
British English tone. Keep each spoken turn under 10 seconds.
`;
// -------------------

const app = express();
app.use(express.urlencoded({ extended: true }));  // Twilio posts form-encoded
app.use(express.json());

// Entry point Twilio hits when a call starts
app.post("/twilio/voice", (req, res) => {
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech"
          language="en-GB"
          speechTimeout="auto"
          action="/twilio/handle-speech"
          method="POST">
    <Say voice="alice">Hi, this is Ironclad’s receptionist. How can I help you today?</Say>
  </Gather>
  <!-- If no speech detected, loop back -->
  <Redirect method="POST">/twilio/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// After Twilio transcribes the caller
app.post("/twilio/handle-speech", async (req, res) => {
  const userText = (req.body.SpeechResult || "").trim();
  console.log("[CALLER SAID]:", userText);

  let reply = "Sorry, I didn't catch that. Could you repeat?";
  if (userText) {
    try {
      // Use native fetch (Node 18+ / Render default runtime)
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",          // small, fast, good for voice turns
          temperature: 0.4,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userText }
          ]
        })
      });
      const data = await r.json();
      reply = data?.choices?.[0]?.message?.content?.trim()
           || "Thanks—could you say that again?";
    } catch (e) {
      console.error("OpenAI error:", e);
      reply = "Hmm, I had a problem fetching a response. Please say that again.";
    }
  }

  // Speak the reply, then loop to listen again
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeForXml(reply)}</Say>
  <Pause length="1"/>
  <Redirect method="POST">/twilio/voice</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Health check
app.get("/", (_req, res) => res.send("OK"));

function escapeForXml(s = "") {
  return s.replace(/&/g,"&amp;")
          .replace(/</g,"&lt;")
          .replace(/>/g,"&gt;")
          .replace(/\"/g,"&quot;")
          .replace(/\'/g,"&apos;");
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
