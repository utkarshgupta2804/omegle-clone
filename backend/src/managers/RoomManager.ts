// src/managers/RoomManager.ts
import { User } from "./UserManger";

let GLOBAL_ROOM_ID = 1;

interface Room {
    user1: User;
    user2: User;
}

interface RoomHistory {
    user1SocketId: string;
    user2SocketId: string;
    timestamp: number;
}

/**
 * Enable lightweight logging for room lifecycle events when ROOM_LOGS=true
 */
const ROOM_LOGS = process.env.ROOM_LOGS === 'true';

export class RoomManager {
    private rooms: Map<string, Room>;
    private roomHistory: RoomHistory[] = [];
    private readonly HISTORY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    constructor() {
        this.rooms = new Map<string, Room>();

        // Clean up old history every minute
        setInterval(() => {
            const now = Date.now();
            this.roomHistory = this.roomHistory.filter(
                h => now - h.timestamp < this.HISTORY_TIMEOUT
            );
        }, 60000);
    }

    /**
     * Check if two users were recently in a room together
     */
    private wereRecentlyMatched(socketId1: string, socketId2: string): boolean {
        return this.roomHistory.some(h =>
            (h.user1SocketId === socketId1 && h.user2SocketId === socketId2) ||
            (h.user1SocketId === socketId2 && h.user2SocketId === socketId1)
        );
    }

    /**
     * Add room pair to history
     */
    private addToHistory(user1SocketId: string, user2SocketId: string) {
        this.roomHistory.push({
            user1SocketId,
            user2SocketId,
            timestamp: Date.now()
        });
    }

    createRoom(user1: User, user2: User) {
        const roomId = this.generate().toString();

        // Check if these users were recently matched
        const wasRecentMatch = this.wereRecentlyMatched(user1.socket.id, user2.socket.id);

        if (wasRecentMatch) {
            if (ROOM_LOGS) {
                console.info(`🔄 Users ${user1.name} and ${user2.name} were recently matched. Asking for reconnection confirmation.`);
            }

            // Notify both users they matched with the same person
            user1.socket.emit("same-user-matched", {
                roomId,
                partnerName: user2.name,
                partnerSocketId: user2.socket.id
            });

            user2.socket.emit("same-user-matched", {
                roomId,
                partnerName: user1.name,
                partnerSocketId: user1.socket.id
            });

            // Store room temporarily (will be confirmed or cancelled)
            this.rooms.set(roomId, { user1, user2 });
        } else {
            // Normal room creation
            this.rooms.set(roomId, { user1, user2 });

            // Add to history
            this.addToHistory(user1.socket.id, user2.socket.id);

            if (ROOM_LOGS) {
                console.info(`Created room ${roomId} for users: ${user1.name} (${user1.socket.id}) and ${user2.name} (${user2.socket.id})`);
            }

            user1.socket.emit("send-offer", { roomId });
            user2.socket.emit("send-offer", { roomId });
        }
    }

    /**
     * Confirm reconnection with the same user
     */
    confirmReconnection(roomId: string, socketId: string) {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const user = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        // Mark this user as confirmed
        user.socket.emit("reconnection-confirmed");

        // Check if both users have confirmed (we'll track this with a flag)
        // For simplicity, we'll start the connection as soon as one confirms
        // and the other will be notified
        otherUser.socket.emit("partner-confirmed-reconnection");

        if (ROOM_LOGS) {
            console.info(`User ${user.name} confirmed reconnection in room ${roomId}`);
        }

        // Update history timestamp
        this.addToHistory(room.user1.socket.id, room.user2.socket.id);

        // Start the connection
        room.user1.socket.emit("send-offer", { roomId });
        room.user2.socket.emit("send-offer", { roomId });
    }

    /**
     * Decline reconnection and find new partner
     */
    declineReconnection(roomId: string, socketId: string): User | null {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        const decliningUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        if (ROOM_LOGS) {
            console.info(`User ${decliningUser.name} declined reconnection in room ${roomId}`);
        }

        // Notify other user
        otherUser.socket.emit("partner-declined-reconnection");

        // Delete the room
        this.rooms.delete(roomId);

        // Return the other user so they can be re-queued
        return otherUser;
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

    removeUserFromRoom(socketId: string): { remainingUser: User | null, removedUser: User | null } | null {
        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId || room.user2.socket.id === socketId) {
                const removedUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
                const remainingUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

                if (ROOM_LOGS) {
                    console.info(`User ${removedUser.name} (${removedUser.socket.id}) removed from room ${roomId}`);
                    console.info(`Remaining user: ${remainingUser.name} (${remainingUser.socket.id})`);
                }

                remainingUser.socket.emit("user-disconnected", {
                    message: "Your chat partner has left the room. Finding you a new partner..."
                });

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