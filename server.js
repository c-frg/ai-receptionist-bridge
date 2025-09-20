import express from "express";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple Twilio voice webhook
app.post("/twilio/voice", (req, res) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hello Tina, your AI receptionist is alive and working.</Say>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

// Default route
app.get("/", (req, res) => {
  res.send("Server is running and ready for Twilio calls!");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
