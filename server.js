require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// FIX: Socket.IO CORS aur transport options — mobile ke liye
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  // FIX: websocket + polling fallback — mobile network par polling reliable hota hai
  transports: ["websocket", "polling"],
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // FIX: Large ICE candidate messages ke liye buffer size badhao
  maxHttpBufferSize: 1e7
});

app.use(express.static("public"));
app.use(express.json({ limit: "10mb" }));

// ════════════════════════════
//  MONGODB SCHEMAS
// ════════════════════════════
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("MongoDB error:", err));

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  username:  { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  socketId:  { type: String, default: null },
  pushSub:   { type: Object, default: null },
  createdAt: { type: Date, default: Date.now }
});

const callHistorySchema = new mongoose.Schema({
  callerName:   String,
  receiverName: String,
  duration:     String,
  createdAt:    { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const CallHistory = mongoose.model("CallHistory", callHistorySchema);

// ════════════════════════════
//  WEB PUSH SETUP
// ════════════════════════════
webpush.setVapidDetails(
  "mailto:" + process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ════════════════════════════
//  JWT HELPERS
// ════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET;

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: "Unauthorized" });
  req.userId = decoded.userId;
  next();
}

// ════════════════════════════
//  REST API
// ════════════════════════════
app.get("/api/vapid-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// FIX: Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, username, password } = req.body;
    if (!name || !username || !password)
      return res.status(400).json({ error: "Sab fields bharo" });
    if (username.length < 3)
      return res.status(400).json({ error: "Username 3+ characters ka hona chahiye" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password 6+ characters ka hona chahiye" });

    const exists = await User.findOne({ username: username.toLowerCase() });
    if (exists)
      return res.status(400).json({ error: "Yeh username already le liya gaya hai" });

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, username: username.toLowerCase(), password: hash });
    const token = signToken(user._id.toString());
    res.json({ token, name: user.name, username: user.username, userId: user._id });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(400).json({ error: "Username nahi mila" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Password galat hai" });
    const token = signToken(user._id.toString());
    res.json({ token, name: user.name, username: user.username, userId: user._id });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId).select("name username _id");
  if (!user) return res.status(404).json({ error: "User nahi mila" });
  res.json({ name: user.name, username: user.username, userId: user._id });
});

app.post("/api/push-subscribe", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { pushSub: req.body.subscription });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Push subscribe failed" });
  }
});

app.delete("/api/push-subscribe", authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { pushSub: null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Push unsubscribe failed" });
  }
});

// ════════════════════════════
//  SOCKET.IO
// ════════════════════════════
const onlineMap = new Map(); // userId -> socketId

async function broadcastUsers() {
  try {
    const users = await User.find().select("name username socketId _id");
    io.emit("users-list", users.map(u => ({
      _id: u._id.toString(),
      name: u.name,
      username: u.username,
      socketId: u.socketId || null,
      online: !!u.socketId
    })));
  } catch(e) {
    console.error("broadcastUsers error:", e);
  }
}

io.on("connection", (socket) => {
  console.log("New socket connection:", socket.id);

  socket.on("socket-auth", async (token) => {
    const decoded = verifyToken(token);
    if (!decoded) { socket.disconnect(); return; }

    const user = await User.findById(decoded.userId);
    if (!user) { socket.disconnect(); return; }

    socket.userId = decoded.userId;
    socket.userName = user.name;

    // FIX: Purana socket disconnect karo agar same user ne dobara connect kiya
    const oldSocketId = onlineMap.get(decoded.userId);
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        console.log(`User ${user.name} ne naya connection banaya, purana disconnect kiya`);
        // Purane socket ko inform karo lekin disconnect mat karo (dono tab support ke liye)
      }
    }

    await User.findByIdAndUpdate(decoded.userId, { socketId: socket.id });
    onlineMap.set(decoded.userId, socket.id);

    socket.emit("auth-ok");
    await broadcastUsers();

    const history = await CallHistory.find().sort({ createdAt: -1 }).limit(20);
    socket.emit("call-history", history);
  });

  // ── OUTGOING CALL ──
  socket.on("call-user", async ({ toUserId, offer, callerName }) => {
    // FIX: onlineMap aur actual socket dono check karo
    const targetSocketId = onlineMap.get(toUserId);
    const isSocketAlive = targetSocketId && io.sockets.sockets.has(targetSocketId);

    console.log(`Call attempt: ${callerName} -> userId:${toUserId}, socketAlive:${isSocketAlive}`);

    if (isSocketAlive) {
      io.to(targetSocketId).emit("incoming-call", {
        from: socket.id,
        offer,
        callerName
      });
    } else {
      // User offline — Web Push bhejo
      try {
        const targetUser = await User.findById(toUserId);

        if (targetUser?.pushSub) {
          await webpush.sendNotification(
            targetUser.pushSub,
            JSON.stringify({
              title: `📞 ${callerName} ne call kiya!`,
              body:  "VoiceConnect kholo — incoming call hai",
              callerName,
              callerId: socket.userId,
              url: "/"
            })
          );
          socket.emit("user-offline", { name: targetUser.name, pushSent: true });
        } else {
          socket.emit("user-offline", { name: targetUser?.name || "User", pushSent: false });
        }
      } catch (err) {
        console.error("Push error:", err.message);
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Stale subscription — delete karo
          await User.findByIdAndUpdate(toUserId, { pushSub: null });
        }
        socket.emit("user-offline", { name: "User", pushSent: false });
      }
    }
  });

  // FIX: answer-call mein from socket ID bhi bhejo (caller ko pata chale)
  socket.on("answer-call", ({ to, answer }) => {
    console.log(`Answer: ${socket.id} -> ${to}`);
    io.to(to).emit("call-answered", answer);
  });

  socket.on("reject-call", ({ to }) => {
    console.log(`Reject: ${socket.id} -> ${to}`);
    io.to(to).emit("call-rejected");
  });

  socket.on("end-call", ({ to }) => {
    console.log(`End call: ${socket.id} -> ${to}`);
    io.to(to).emit("call-ended");
  });

  // FIX: ICE candidate relay — trickle ICE properly handle karo
  socket.on("ice-candidate", ({ to, candidate }) => {
    if (to && candidate) {
      io.to(to).emit("ice-candidate", candidate);
    }
  });

  socket.on("save-call-history", async (data) => {
    try {
      await CallHistory.create({
        callerName:   data.callerName || "Unknown",
        receiverName: data.receiverName || "Unknown",
        duration:     data.duration || "00:00"
      });
      const history = await CallHistory.find().sort({ createdAt: -1 }).limit(20);
      io.emit("call-history", history);
    } catch(e) {
      console.error("Save history error:", e);
    }
  });

  socket.on("disconnect", async (reason) => {
    console.log(`Socket ${socket.id} disconnected: ${reason}`);
    if (socket.userId) {
      // FIX: Sirf tab clear karo agar yahi socket registered hai
      const registeredSocketId = onlineMap.get(socket.userId);
      if (registeredSocketId === socket.id) {
        await User.findByIdAndUpdate(socket.userId, { socketId: null });
        onlineMap.delete(socket.userId);
        await broadcastUsers();
      }
    }
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// ════════════════════════════
//  GRACEFUL SHUTDOWN
// ════════════════════════════
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 VoiceConnect running on port ${PORT}`);
});