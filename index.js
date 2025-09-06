require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://10.0.2.2:3000",
      "http://192.168.100.79:3000",
    ],
    credentials: true,
  })
);
app.use(express.json());

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "eur" } = req.body;

    if (!amount || amount < 50) {
      return res.status(400).json({
        error: "Amount must be at least 50 cents",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        order_id: `order_${Date.now()}`,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Payment Intent creation error:", error);
    res.status(500).json({
      error: "Failed to create payment intent",
      message: error.message,
    });
  }
});

app.get("/payment-status/:paymentIntentId", async (req, res) => {
  try {
    const { paymentIntentId } = req.params;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    res.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error("Payment status error:", error);
    res.status(500).json({
      error: "Failed to retrieve payment status",
    });
  }
});

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded":
      const paymentIntent = event.data.object;
      console.log("Payment succeeded:", paymentIntent.id);
      break;

    case "payment_intent.payment_failed":
      console.log("Payment failed:", event.data.object.id);
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

app.get("/", (req, res) => {
  res.json({ message: "Stripe Payment Server is running!" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;
