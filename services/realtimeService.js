import { Server } from "socket.io";
import jwt from "jsonwebtoken";

/**
 * Socket.IO realtime layer — replaces Supabase Realtime broadcast.
 * Clients connect with { auth: { token: <backend JWT> } } and are joined
 * to a per-user room; notifications are emitted only to the target user.
 */

let io = null;

export function initRealtime(httpServer) {
    io = new Server(httpServer, {
        cors: { origin: "*" }, // matches the API's existing open CORS policy
        path: "/socket.io",
    });

    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error("unauthorized"));
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            socket.userId = decoded.id;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    });

    io.on("connection", (socket) => {
        socket.join(`user:${socket.userId}`);
    });

    console.log("🔌 Realtime: Socket.IO initialized");
    return io;
}

/** Emit a notification ping to one user (no-op if realtime not initialized). */
export function emitNotification(userId, payload = {}) {
    if (!io) return;
    io.to(`user:${userId}`).emit("new_notification", { user_id: userId, ...payload });
}
