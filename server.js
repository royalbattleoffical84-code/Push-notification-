const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ---------- FIREBASE ADMIN SETUP ----------
// Render pe environment variable se service account JSON aayegi (base64 encoded)
// Setup steps neeche README mein hain
const serviceAccountJson = Buffer.from(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
  "base64"
).toString("utf-8");

const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ---------- IN-MEMORY TOKEN STORE (basic version) ----------
// Production mein isko database (Firestore/MongoDB) mein rakhna,
// lekin shuru karne ke liye ye kaafi hai.
let tokens = new Set();

// ---------- ROUTES ----------

// Health check - Render pe deploy hua ya nahi check karne ke liye
app.get("/", (req, res) => {
  res.send("Push notification backend chal raha hai ✅");
});

// 1) Android app se FCM token save karna
// App login/open hone par ye call karo
app.post("/register-token", (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: "token missing hai" });
  }
  tokens.add(token);
  console.log("Token saved. Total tokens:", tokens.size);
  res.json({ success: true, totalTokens: tokens.size });
});

// 2) Manual notification bhejna (admin panel se call karoge)
// Ek specific token ya sabko bhej sakte ho
app.post("/send-notification", async (req, res) => {
  const { title, body, token, data } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: "title aur body zaroori hai" });
  }

  try {
    if (token) {
      // Single device ko bhejo
      const result = await sendPushNotification(token, title, body, data);
      return res.json({ success: true, result });
    } else {
      // Sabko bhejo (broadcast)
      const results = await sendToAll(title, body, data);
      return res.json({ success: true, sentTo: results.length });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) Automatic trigger ke liye example route
// Jaise "naya order aaya" event pe ye call karo (apne app logic se)
app.post("/event/new-order", async (req, res) => {
  const { orderId, customerName } = req.body;

  try {
    await sendToAll(
      "Naya Order Aaya! 🛒",
      `${customerName} ne order diya hai (ID: ${orderId})`,
      { orderId: String(orderId) }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- HELPER FUNCTIONS ----------

async function sendPushNotification(token, title, body, data = {}) {
  const message = {
    token,
    notification: { title, body },
    data,
  };
  return admin.messaging().send(message);
}

async function sendToAll(title, body, data = {}) {
  const tokenList = Array.from(tokens);
  if (tokenList.length === 0) {
    console.log("Koi token registered nahi hai");
    return [];
  }

  const message = {
    notification: { title, body },
    data,
    tokens: tokenList,
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`${response.successCount} bheje gaye, ${response.failureCount} fail hue`);
  return tokenList;
}

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chal raha hai port ${PORT} par`);
});
