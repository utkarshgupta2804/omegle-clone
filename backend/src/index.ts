// index.ts
import { Socket } from "socket.io";
import http from "http";
import express from 'express';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { UserManager } from "./managers/UserManger";

// Load .env (safe to call even if .env absent)
dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"]
  }
});

const userManager = new UserManager();

io.on('connection', (socket: Socket) => {
  // Minimal connection log
  console.info('User connected:', socket.id);

  socket.on("join", ({ name }: { name: string }) => {
    userManager.addUser(name || "Anonymous", socket);
  });

  socket.on("disconnect", () => {
    console.info('User disconnected:', socket.id);
    userManager.removeUser(socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.info(`Server listening on port ${PORT}`);
});
