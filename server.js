require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server);

app.use(express.static("public"));

mongoose.connect(process.env.MONGO_URI)
.then(() => {
    console.log("MongoDB Connected");
})
.catch((err) => {
    console.log(err);
});

const userSchema = new mongoose.Schema({
    name: String,
    socketId: String
});

const callHistorySchema = new mongoose.Schema({
    callerName: String,
    receiverName: String,
    duration: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const User = mongoose.model("User", userSchema);

const CallHistory = mongoose.model(
    "CallHistory",
    callHistorySchema
);

io.on("connection", (socket) => {

    console.log("Connected:", socket.id);

    socket.on("register-user", async (name) => {

        await User.deleteMany({
            socketId: socket.id
        });

        await User.create({
            name,
            socketId: socket.id
        });

        const users = await User.find();

        io.emit("users-list", users);

        const history = await CallHistory.find()
        .sort({ createdAt: -1 })
        .limit(20);

        socket.emit("call-history", history);

    });

    socket.on("call-user", ({ to, offer, callerName }) => {

        io.to(to).emit("incoming-call", {
            from: socket.id,
            offer,
            callerName
        });

    });

    socket.on("answer-call", ({
        to,
        answer
    }) => {

        io.to(to).emit("call-answered", answer);

    });

    socket.on("reject-call", ({ to }) => {

        io.to(to).emit("call-rejected");

    });

    socket.on("end-call", ({ to }) => {

        io.to(to).emit("call-ended");

    });

    socket.on("save-call-history", async(data)=>{

        await CallHistory.create(data);

        const history = await CallHistory.find()
        .sort({ createdAt: -1 })
        .limit(20);

        io.emit("call-history", history);

    });

    socket.on("ice-candidate", ({
        to,
        candidate
    }) => {

        io.to(to).emit(
            "ice-candidate",
            candidate
        );

    });

    socket.on("disconnect", async () => {

        await User.deleteOne({
            socketId: socket.id
        });

        const users = await User.find();

        io.emit("users-list", users);

        console.log("Disconnected");

    });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {

    console.log(`Running On ${PORT}`);

});