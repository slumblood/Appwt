import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// CORS configuration for production
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Store active rooms and users
const activeRooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join-room', (roomId, userId) => {
    console.log(`User ${userId} joining room ${roomId}`);
    
    if (!activeRooms.has(roomId)) {
      activeRooms.set(roomId, new Set());
    }
    
    activeRooms.get(roomId).add(userId);
    socket.join(roomId);
    
    socket.to(roomId).emit('user-connected', userId);
    
    // Send current room users to the new user
    const users = Array.from(activeRooms.get(roomId) || []);
    socket.emit('room-users', users);
    
    console.log(`Room ${roomId} now has users:`, users);
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(data.room).emit('offer', {
      offer: data.offer,
      from: data.from
    });
  });

  socket.on('answer', (data) => {
    socket.to(data.room).emit('answer', {
      answer: data.answer,
      from: data.from
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.room).emit('ice-candidate', {
      candidate: data.candidate,
      from: data.from
    });
  });

  // Push-to-talk state
  socket.on('user-talking', (data) => {
    socket.to(data.room).emit('user-talking', {
      userId: data.userId,
      isTalking: data.isTalking
    });
  });

  // Leave room
  socket.on('leave-room', (roomId, userId) => {
    console.log(`User ${userId} leaving room ${roomId}`);
    
    if (activeRooms.has(roomId)) {
      activeRooms.get(roomId).delete(userId);
      if (activeRooms.get(roomId).size === 0) {
        activeRooms.delete(roomId);
      }
    }
    
    socket.leave(roomId);
    socket.to(roomId).emit('user-disconnected', userId);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Clean up rooms
    for (const [roomId, users] of activeRooms.entries()) {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        socket.to(roomId).emit('user-disconnected', socket.id);
        
        if (users.size === 0) {
          activeRooms.delete(roomId);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Signaling server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});