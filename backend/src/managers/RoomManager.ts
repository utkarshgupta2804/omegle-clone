// src/managers/RoomManager.ts
import { User } from "./UserManger";

let GLOBAL_ROOM_ID = 1;

interface Room {
    user1: User;
    user2: User;
}

/**
 * Enable lightweight logging for room lifecycle events when ROOM_LOGS=true
 */
const ROOM_LOGS = process.env.ROOM_LOGS === 'true';

export class RoomManager {
    private rooms: Map<string, Room>;

    constructor() {
        this.rooms = new Map<string, Room>();
    }

    createRoom(user1: User, user2: User) {
        const roomId = this.generate().toString();
        this.rooms.set(roomId, { user1, user2 });

        if (ROOM_LOGS) {
            console.info(`Created room ${roomId} for users: ${user1.name} (${user1.socket.id}) and ${user2.name} (${user2.socket.id})`);
        }

        user1.socket.emit("send-offer", { roomId });
        user2.socket.emit("send-offer", { roomId });
    }

    onOffer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found for offer`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        receivingUser.socket.emit("offer", { sdp, roomId });
    }

    onAnswer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found for answer`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        receivingUser.socket.emit("answer", { sdp, roomId });
    }

    onIceCandidates(roomId: string, senderSocketid: string, candidate: any, type: "sender" | "receiver") {
        const room = this.rooms.get(roomId);
        if (!room) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found for ICE candidate`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2 : room.user1;
        receivingUser.socket.emit("add-ice-candidate", { candidate, type });
    }

    onMessage(roomId: string, senderSocketId: string, message: string, senderName: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found for message`);
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        const sendingUser = room.user1.socket.id === senderSocketId ? room.user1 : room.user2;

        receivingUser.socket.emit("receive-message", {
            message,
            sender: "stranger",
            senderName,
            timestamp: new Date().toISOString()
        });

        sendingUser.socket.emit("message-sent", {
            message,
            timestamp: new Date().toISOString()
        });
    }

    onTyping(roomId: string, senderSocketId: string, isTyping: boolean) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const receivingUser = room.user1.socket.id === senderSocketId ? room.user2 : room.user1;
        receivingUser.socket.emit("user-typing", { isTyping });
    }

    /**
     * Remove both users from the room if socketId belongs to either user.
     * Returns an object containing both the remaining user (if any) and the removed user.
     *
     * - If this removal is triggered by a voluntary leave/new-chat, both sockets may be connected.
     * - If triggered by a real socket disconnect, removedUser.socket.connected will usually be false.
     */
    removeUserFromRoom(socketId: string): { remainingUser: User | null, removedUser: User | null } | null {
        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId || room.user2.socket.id === socketId) {
                const removedUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
                const remainingUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

                if (ROOM_LOGS) {
                    console.info(`User ${removedUser.name} (${removedUser.socket.id}) removed from room ${roomId}`);
                    console.info(`Remaining user: ${remainingUser.name} (${remainingUser.socket.id})`);
                }

                // Notify remaining user that partner left (client handles requeue UI)
                remainingUser.socket.emit("user-disconnected", {
                    message: "Your chat partner has left the room. Finding you a new partner..."
                });

                // delete room
                this.rooms.delete(roomId);

                return { remainingUser, removedUser };
            }
        }
        return null;
    }

    getRoomBySocketId(socketId: string): { roomId: string, room: Room } | null {
        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId || room.user2.socket.id === socketId) {
                return { roomId, room };
            }
        }
        return null;
    }

    getActiveRooms(): number {
        return this.rooms.size;
    }

    private generate() {
        return GLOBAL_ROOM_ID++;
    }
}
