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
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static("public"));
app.use(express.json());

// ════════════════════════════
//  MONGODB SCHEMAS
// ════════════════════════════
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log(err));

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

// Push subscription delete karo (optional — logout pe cleanup)
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
  const users = await User.find().select("name username socketId _id");
  io.emit("users-list", users.map(u => ({
    _id: u._id.toString(),
    name: u.name,
    username: u.username,
    socketId: u.socketId || null,
    online: !!u.socketId
  })));
}

io.on("connection", (socket) => {

  socket.on("socket-auth", async (token) => {
    const decoded = verifyToken(token);
    if (!decoded) { socket.disconnect(); return; }

    const user = await User.findById(decoded.userId);
    if (!user) { socket.disconnect(); return; }

    socket.userId = decoded.userId;
    socket.userName = user.name;

    await User.findByIdAndUpdate(decoded.userId, { socketId: socket.id });
    onlineMap.set(decoded.userId, socket.id);

    socket.emit("auth-ok");
    await broadcastUsers();

    const history = await CallHistory.find().sort({ createdAt: -1 }).limit(20);
    socket.emit("call-history", history);
  });

  // ── OUTGOING CALL ──
  socket.on("call-user", async ({ toUserId, offer, callerName }) => {
    // Online map se check karo aur socket actually connected hai ya nahi
    const targetSocketId = onlineMap.get(toUserId);
    const isSocketAlive = targetSocketId && io.sockets.sockets.get(targetSocketId);

    if (isSocketAlive) {
      // User online hai — WebRTC call
      io.to(targetSocketId).emit("incoming-call", {
        from: socket.id,
        offer,
        callerName
      });
    } else {
      // User offline ya doosre tab pe — Web Push bhejo
      try {
        const targetUser = await User.findById(toUserId);

        if (targetUser?.pushSub) {
          await webpush.sendNotification(
            targetUser.pushSub,
            JSON.stringify({
              title: `📞 ${callerName} ne call kiya!`,
              body: "VoiceConnect kholo — incoming call hai",
              callerName,
              callerId: socket.userId,
              url: "/"
            })
          );
          socket.emit("user-offline", { name: targetUser.name, pushSent: true });
        } else {
          // Push subscription bhi nahi hai
          socket.emit("user-offline", { name: targetUser?.name || "User", pushSent: false });
        }
      } catch (err) {
        console.error("Push error:", err.message);
        // Stale subscription — delete karo
        if (err.statusCode === 410) {
          await User.findByIdAndUpdate(toUserId, { pushSub: null });
        }
        socket.emit("user-offline", { name: "User", pushSent: false });
      }
    }
  });

  socket.on("answer-call",   ({ to, answer })    => io.to(to).emit("call-answered", answer));
  socket.on("reject-call",   ({ to })             => io.to(to).emit("call-rejected"));
  socket.on("end-call",      ({ to })             => io.to(to).emit("call-ended"));
  socket.on("ice-candidate", ({ to, candidate })  => io.to(to).emit("ice-candidate", candidate));

  socket.on("save-call-history", async (data) => {
    await CallHistory.create(data);
    const history = await CallHistory.find().sort({ createdAt: -1 }).limit(20);
    io.emit("call-history", history);
  });

  socket.on("disconnect", async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, { socketId: null });
      onlineMap.delete(socket.userId);
      await broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));