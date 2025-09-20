import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Twilio webhook
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="alice">Hello Tina, your AI receptionist is alive!</Say>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
