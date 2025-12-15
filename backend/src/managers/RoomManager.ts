// src/managers/RoomManager.ts
import { User } from "./UserManger";

let GLOBAL_ROOM_ID = 1;

interface Room {
    user1: User;
    user2: User;
    user1Confirmed?: boolean;
    user2Confirmed?: boolean;
    isPendingReconnection?: boolean;
    reconnectionTimeout?: NodeJS.Timeout; // NEW: Timeout for reconnection prompt
}

interface RoomHistory {
    user1SocketId: string;
    user2SocketId: string;
    timestamp: number;
}

interface DisconnectCooldown {
    user1SocketId: string;
    user2SocketId: string;
    timestamp: number;
}

const ROOM_LOGS = process.env.ROOM_LOGS === 'true';
const RECONNECTION_TIMEOUT = parseInt(process.env.RECONNECTION_TIMEOUT_MS || "30000", 10); // 30 seconds

export class RoomManager {
    private rooms: Map<string, Room>;
    private roomHistory: RoomHistory[] = [];
    private disconnectCooldowns: DisconnectCooldown[] = [];
    private readonly HISTORY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
    private readonly DISCONNECT_COOLDOWN = 3 * 1000; // 30 seconds cooldown

    constructor() {
        this.rooms = new Map<string, Room>();

        setInterval(() => {
            const now = Date.now();
            this.roomHistory = this.roomHistory.filter(
                h => now - h.timestamp < this.HISTORY_TIMEOUT
            );
            this.disconnectCooldowns = this.disconnectCooldowns.filter(
                d => now - d.timestamp < this.DISCONNECT_COOLDOWN
            );
        }, 60000);
    }

    private wereRecentlyMatched(socketId1: string, socketId2: string): boolean {
        return this.roomHistory.some(h =>
            (h.user1SocketId === socketId1 && h.user2SocketId === socketId2) ||
            (h.user1SocketId === socketId2 && h.user2SocketId === socketId1)
        );
    }

    private isInDisconnectCooldown(socketId1: string, socketId2: string): boolean {
        const now = Date.now();
        return this.disconnectCooldowns.some(d => {
            const isMatch = (d.user1SocketId === socketId1 && d.user2SocketId === socketId2) ||
                           (d.user1SocketId === socketId2 && d.user2SocketId === socketId1);
            return isMatch && (now - d.timestamp < this.DISCONNECT_COOLDOWN);
        });
    }

    private addToDisconnectCooldown(user1SocketId: string, user2SocketId: string) {
        this.disconnectCooldowns.push({
            user1SocketId,
            user2SocketId,
            timestamp: Date.now()
        });
        
        if (ROOM_LOGS) {
            console.info(`🚫 Added disconnect cooldown for ${user1SocketId} and ${user2SocketId}`);
        }
    }

    private removeFromDisconnectCooldown(user1SocketId: string, user2SocketId: string) {
        this.disconnectCooldowns = this.disconnectCooldowns.filter(d =>
            !((d.user1SocketId === user1SocketId && d.user2SocketId === user2SocketId) ||
              (d.user1SocketId === user2SocketId && d.user2SocketId === user1SocketId))
        );
    }

    private addToHistory(user1SocketId: string, user2SocketId: string) {
        this.roomHistory.push({
            user1SocketId,
            user2SocketId,
            timestamp: Date.now()
        });
    }

    createRoom(user1: User, user2: User) {
        if (this.isInDisconnectCooldown(user1.socket.id, user2.socket.id)) {
            if (ROOM_LOGS) {
                console.info(`⏳ Users ${user1.name} and ${user2.name} are in disconnect cooldown. Skipping match.`);
            }
            return false;
        }

        const roomId = this.generate().toString();
        const wasRecentMatch = this.wereRecentlyMatched(user1.socket.id, user2.socket.id);

        if (wasRecentMatch) {
            if (ROOM_LOGS) {
                console.info(`🔄 Users ${user1.name} and ${user2.name} were recently matched. Asking for reconnection confirmation.`);
            }

            // NEW: Set up timeout for reconnection
            const timeout = setTimeout(() => {
                const room = this.rooms.get(roomId);
                if (room && room.isPendingReconnection) {
                    if (ROOM_LOGS) {
                        console.info(`⏰ Reconnection timeout for room ${roomId}. Neither or only one user confirmed.`);
                    }
                    
                    // Notify both users that reconnection expired
                    room.user1.socket.emit("reconnection-timeout");
                    room.user2.socket.emit("reconnection-timeout");
                    
                    // Delete the room
                    this.rooms.delete(roomId);
                    
                    // Return both users (will be handled by timeout event in UserManager)
                }
            }, RECONNECTION_TIMEOUT);

            this.rooms.set(roomId, { 
                user1, 
                user2,
                user1Confirmed: false,
                user2Confirmed: false,
                isPendingReconnection: true,
                reconnectionTimeout: timeout // Store timeout
            });

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
        } else {
            this.rooms.set(roomId, { 
                user1, 
                user2,
                isPendingReconnection: false
            });

            this.addToHistory(user1.socket.id, user2.socket.id);

            if (ROOM_LOGS) {
                console.info(`✅ Created room ${roomId} for users: ${user1.name} and ${user2.name}`);
            }

            user1.socket.emit("send-offer", { roomId });
            user2.socket.emit("send-offer", { roomId });
        }

        return true;
    }

    confirmReconnection(roomId: string, socketId: string) {
        const room = this.rooms.get(roomId);
        if (!room || !room.isPendingReconnection) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found or not pending reconnection`);
            return;
        }

        // Mark the confirming user
        if (room.user1.socket.id === socketId) {
            room.user1Confirmed = true;
        } else if (room.user2.socket.id === socketId) {
            room.user2Confirmed = true;
        }

        const user = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        if (ROOM_LOGS) {
            console.info(`✅ User ${user.name} confirmed reconnection in room ${roomId}`);
            console.info(`   Status: user1=${room.user1Confirmed}, user2=${room.user2Confirmed}`);
        }

        // NEW: Notify confirming user to show "waiting" state
        user.socket.emit("reconnection-confirmed");

        // NEW: Notify other user that partner confirmed (but DON'T hide their prompt)
        otherUser.socket.emit("partner-waiting", {
            partnerName: user.name
        });

        // Check if BOTH users have confirmed
        if (room.user1Confirmed && room.user2Confirmed) {
            // NEW: Clear the timeout since both confirmed
            if (room.reconnectionTimeout) {
                clearTimeout(room.reconnectionTimeout);
                room.reconnectionTimeout = undefined;
            }

            if (ROOM_LOGS) {
                console.info(`🎉 Both users confirmed reconnection in room ${roomId}. Starting connection...`);
            }

            room.isPendingReconnection = false;
            this.addToHistory(room.user1.socket.id, room.user2.socket.id);
            this.removeFromDisconnectCooldown(room.user1.socket.id, room.user2.socket.id);

            // Notify both that connection is starting
            room.user1.socket.emit("both-confirmed-reconnection");
            room.user2.socket.emit("both-confirmed-reconnection");

            setTimeout(() => {
                room.user1.socket.emit("send-offer", { roomId });
                room.user2.socket.emit("send-offer", { roomId });
            }, 100);
        }
    }

    declineReconnection(roomId: string, socketId: string): { user1: User, user2: User } | null {
        const room = this.rooms.get(roomId);
        if (!room) return null;

        // NEW: Clear the timeout since someone declined
        if (room.reconnectionTimeout) {
            clearTimeout(room.reconnectionTimeout);
            room.reconnectionTimeout = undefined;
        }

        const decliningUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        if (ROOM_LOGS) {
            console.info(`❌ User ${decliningUser.name} declined reconnection in room ${roomId}`);
        }

        // Notify other user
        otherUser.socket.emit("partner-declined-reconnection");

        // Delete the room
        this.rooms.delete(roomId);

        // NEW: Return both users so they can be re-queued
        return { user1: room.user1, user2: room.user2 };
    }

    onOffer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} not found for offer`);
            return;
        }
        
        if (room.isPendingReconnection) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} still pending reconnection, ignoring offer`);
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

        if (room.isPendingReconnection) {
            if (ROOM_LOGS) console.warn(`Room ${roomId} still pending reconnection, ignoring answer`);
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

        if (room.isPendingReconnection) {
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
                // NEW: Clear reconnection timeout if exists
                if (room.reconnectionTimeout) {
                    clearTimeout(room.reconnectionTimeout);
                }

                const removedUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
                const remainingUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

                this.addToDisconnectCooldown(room.user1.socket.id, room.user2.socket.id);

                if (ROOM_LOGS) {
                    console.info(`🚪 User ${removedUser.name} (${removedUser.socket.id}) removed from room ${roomId}`);
                    console.info(`   Remaining user: ${remainingUser.name} (${remainingUser.socket.id})`);
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