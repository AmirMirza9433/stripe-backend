require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Client, Environment, ApiError } = require("squareup");

const app = express();
const port = 3000;

// Initialize Square client with new SDK
const squareClient = new Client({
  accessToken:
    "EAAAl1MDPOnQFsFv_t6ZYX2Jg4N4hlpxogwGZanAyZaPw1DkXLClKd97sxfr1irI",
  environment: Environment.Production,
});

const { paymentsApi, customersApi, cardsApi, locationsApi } = squareClient;

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

// Create payment without CVV using source ID (nonce)
app.post("/create-square-payment", async (req, res) => {
  try {
    const { amount, currency = "USD", sourceId, locationId } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: "Minimum amount should be 1 cent",
      });
    }

    if (!sourceId) {
      return res.status(400).json({
        success: false,
        error: "Payment source ID (nonce) required",
      });
    }

    // Create payment request - CVV verification is optional with nonce
    const requestBody = {
      sourceId: sourceId,
      idempotencyKey: generateIdempotencyKey(),
      amountMoney: {
        amount: BigInt(amount), // Amount in smallest currency unit
        currency: currency.toUpperCase(),
      },
      locationId: locationId || "SQUARE_LOCATION_ID",
      acceptPartialAuthorization: false,
      autocomplete: true,
      note: "Payment processed without CVV verification",
      // Optional: Add order reference
      orderId: `ORDER_${Date.now()}`,
    };

    console.log("Creating Square payment with request:", requestBody);

    const response = await paymentsApi.createPayment(requestBody);

    if (!response.result) {
      console.error("No result in Square response");
      return res.status(400).json({
        success: false,
        error: "Payment processing failed - no result",
      });
    }

    const payment = response.result.payment;

    // Save transaction record
    await saveTransactionRecord({
      squarePaymentId: payment.id,
      amount: payment.amountMoney.amount,
      currency: payment.amountMoney.currency,
      status: payment.status,
      sourceType: payment.sourceType,
      cardDetails: payment.cardDetails,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    });

    res.json({
      success: true,
      paymentId: payment.id,
      amount: Number(payment.amountMoney.amount),
      currency: payment.amountMoney.currency,
      status: payment.status,
      receiptNumber: payment.receiptNumber,
      receiptUrl: payment.receiptUrl,
      message: "Payment processed successfully without CVV",
      cardDetails: payment.cardDetails
        ? {
            brand: payment.cardDetails.card?.cardBrand,
            lastFour: payment.cardDetails.card?.last4,
            expMonth: payment.cardDetails.card?.expMonth,
            expYear: payment.cardDetails.card?.expYear,
            fingerprint: payment.cardDetails.card?.fingerprint,
          }
        : null,
    });
  } catch (error) {
    console.error("Square payment error:", error);

    if (error instanceof ApiError) {
      const errors = error.result?.errors || [];
      console.error("Square API errors:", errors);

      return res.status(400).json({
        success: false,
        error: errors[0]?.detail || "Square API error",
        errors: errors,
        category: errors[0]?.category,
        code: errors[0]?.code,
      });
    }

    res.status(500).json({
      success: false,
      error: "Payment processing failed",
      message: error.message,
    });
  }
});

// Create customer for storing cards
app.post("/create-square-customer", async (req, res) => {
  try {
    const { givenName, familyName, emailAddress, phoneNumber, companyName } =
      req.body;

    const requestBody = {
      givenName: givenName,
      familyName: familyName,
      emailAddress: emailAddress,
      phoneNumber: phoneNumber,
      companyName: companyName,
    };

    const response = await customersApi.createCustomer(requestBody);

    if (!response.result?.customer) {
      return res.status(400).json({
        success: false,
        error: "Customer creation failed",
      });
    }

    res.json({
      success: true,
      customer: response.result.customer,
      customerId: response.result.customer.id,
      message: "Customer created successfully",
    });
  } catch (error) {
    console.error("Create customer error:", error);

    if (error instanceof ApiError) {
      const errors = error.result?.errors || [];
      return res.status(400).json({
        success: false,
        error: errors[0]?.detail || "Customer creation failed",
        errors: errors,
      });
    }

    res.status(500).json({
      success: false,
      error: "Customer creation failed",
      message: error.message,
    });
  }
});

// Store card on file for future payments (no CVV needed for stored cards)
app.post("/store-card", async (req, res) => {
  try {
    const { customerId, sourceId, cardNonce } = req.body;

    if (!customerId || (!sourceId && !cardNonce)) {
      return res.status(400).json({
        success: false,
        error: "Customer ID and source ID/card nonce required",
      });
    }

    const requestBody = {
      idempotencyKey: generateIdempotencyKey(),
      sourceId: sourceId || cardNonce,
      customerId: customerId,
    };

    const response = await cardsApi.createCard(requestBody);

    if (!response.result?.card) {
      return res.status(400).json({
        success: false,
        error: "Card storage failed",
      });
    }

    const card = response.result.card;

    res.json({
      success: true,
      card: card,
      cardId: card.id,
      lastFour: card.last4,
      cardBrand: card.cardBrand,
      expMonth: card.expMonth,
      expYear: card.expYear,
      message: "Card stored successfully - future payments won't require CVV",
    });
  } catch (error) {
    console.error("Store card error:", error);

    if (error instanceof ApiError) {
      const errors = error.result?.errors || [];
      return res.status(400).json({
        success: false,
        error: errors[0]?.detail || "Card storage failed",
        errors: errors,
      });
    }

    res.status(500).json({
      success: false,
      error: "Card storage failed",
      message: error.message,
    });
  }
});

// Payment with stored card (no CVV required)
app.post("/pay-with-stored-card", async (req, res) => {
  try {
    const { amount, currency = "USD", cardId, customerId } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        error: "Minimum amount should be 1 cent",
      });
    }

    if (!cardId) {
      return res.status(400).json({
        success: false,
        error: "Card ID required for stored card payment",
      });
    }

    const requestBody = {
      sourceId: cardId, // Using stored card ID
      idempotencyKey: generateIdempotencyKey(),
      amountMoney: {
        amount: BigInt(amount),
        currency: currency.toUpperCase(),
      },
      locationId: "SQUARE_LOCATION_ID",
      customerId: customerId,
      autocomplete: true,
      note: "Payment with stored card - no CVV required",
    };

    const response = await paymentsApi.createPayment(requestBody);

    if (!response.result?.payment) {
      return res.status(400).json({
        success: false,
        error: "Payment with stored card failed",
      });
    }

    const payment = response.result.payment;

    res.json({
      success: true,
      paymentId: payment.id,
      amount: Number(payment.amountMoney.amount),
      currency: payment.amountMoney.currency,
      status: payment.status,
      receiptNumber: payment.receiptNumber,
      message: "Payment successful with stored card",
    });
  } catch (error) {
    console.error("Stored card payment error:", error);

    if (error instanceof ApiError) {
      const errors = error.result?.errors || [];
      return res.status(400).json({
        success: false,
        error: errors[0]?.detail || "Stored card payment failed",
        errors: errors,
      });
    }

    res.status(500).json({
      success: false,
      error: "Payment failed",
      message: error.message,
    });
  }
});

// Get payment status
app.get("/payment-status/:paymentId", async (req, res) => {
  try {
    const { paymentId } = req.params;

    const response = await paymentsApi.getPayment(paymentId);

    if (!response.result?.payment) {
      return res.status(404).json({
        success: false,
        error: "Payment not found",
      });
    }

    const payment = response.result.payment;

    res.json({
      success: true,
      payment: payment,
      status: payment.status,
      amount: Number(payment.amountMoney.amount),
      currency: payment.amountMoney.currency,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    });
  } catch (error) {
    console.error("Get payment status error:", error);

    if (error instanceof ApiError) {
      const errors = error.result?.errors || [];
      return res.status(400).json({
        success: false,
        error: errors[0]?.detail || "Failed to get payment status",
        errors: errors,
      });
    }

    res.status(500).json({
      success: false,
      error: "Failed to get payment status",
      message: error.message,
    });
  }
});

// Get Square locations
app.get("/square-locations", async (req, res) => {
  try {
    const response = await locationsApi.listLocations();

    if (!response.result?.locations) {
      return res.status(400).json({
        success: false,
        error: "No locations found",
      });
    }

    res.json({
      success: true,
      locations: response.result.locations.map((location) => ({
        id: location.id,
        name: location.name,
        address: location.address,
        status: location.status,
        capabilities: location.capabilities,
      })),
    });
  } catch (error) {
    console.error("Get locations error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get locations",
      message: error.message,
    });
  }
});

// Helper functions
function generateIdempotencyKey() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function saveTransactionRecord(transactionData) {
  // Save to your database (MongoDB, PostgreSQL, etc.)
  console.log("Transaction saved:", {
    ...transactionData,
    amount: Number(transactionData.amount), // Convert BigInt to Number for logging
  });

  // Example: Save to database
  /*
  const db = await connectToDatabase();
  await db.collection('square_transactions').insertOne({
    ...transactionData,
    amount: Number(transactionData.amount),
    savedAt: new Date(),
  });
  */
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Square Payment Server is running!",
    environment: "production",
    sdkVersion: "squareup v29+",
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: "development" ? error.message : "Something went wrong",
  });
});

app.listen(port, () => {
  console.log(`Square Payment Server running on port ${port}`);
  console.log(`Environment: production`);
  console.log(`Square SDK: squareup (latest)`);
});

module.exports = app;
