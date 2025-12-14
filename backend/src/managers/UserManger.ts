// src/managers/UserManger.ts
import { Socket } from "socket.io";
import { RoomManager } from "./RoomManager";
import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const REDIS_USERNAME = process.env.REDIS_USERNAME || undefined;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;
const REDIS_TLS = (process.env.REDIS_TLS || "false") === "true";
const REDIS_TLS_REJECT_UNAUTHORIZED = (process.env.REDIS_TLS_REJECT_UNAUTHORIZED || "true") === "true";

const REDIS_MAX_RETRIES = parseInt(process.env.REDIS_MAX_RETRIES || "3", 10);
const REDIS_RETRY_DELAY_CAP_MS = parseInt(process.env.REDIS_RETRY_DELAY_CAP_MS || "2000", 10);

const QUEUE_KEY_ENV = process.env.QUEUE_KEY || "chat:waiting_queue";
const USER_DATA_PREFIX_ENV = process.env.USER_DATA_PREFIX || "chat:user:";
const USER_TTL_SECONDS = parseInt(process.env.USER_TTL_SECONDS || "3600", 10);

const QUEUE_LOGS = (process.env.QUEUE_LOGS || "false") === "true";

export interface User {
    socket: Socket;
    name: string;
}

export class UserManager {
    private users: User[];
    private roomManager: RoomManager;
    private redis: Redis | null = null;
    private redisAvailable: boolean = false;
    private localQueue: string[] = [];

    private readonly QUEUE_KEY = QUEUE_KEY_ENV;
    private readonly USER_DATA_PREFIX = USER_DATA_PREFIX_ENV;
    private readonly USER_TTL = USER_TTL_SECONDS;

    constructor() {
        this.users = [];
        this.roomManager = new RoomManager();

        try {
            const buildOptions = (): any => {
                if (REDIS_URL) return REDIS_URL;

                const opts: any = {
                    host: REDIS_HOST,
                    port: REDIS_PORT,
                    lazyConnect: true,
                    connectTimeout: 5000,
                    maxRetriesPerRequest: REDIS_MAX_RETRIES,
                    retryStrategy: (times: number) => {
                        if (times > REDIS_MAX_RETRIES) return null;
                        return Math.min(times * 50, REDIS_RETRY_DELAY_CAP_MS);
                    }
                };

                if (REDIS_USERNAME) opts.username = REDIS_USERNAME;
                if (REDIS_PASSWORD) opts.password = REDIS_PASSWORD;

                if (REDIS_TLS) {
                    opts.tls = REDIS_TLS_REJECT_UNAUTHORIZED ? {} : { rejectUnauthorized: false };
                }

                return opts;
            };

            const client = new Redis(buildOptions() as any);

            let connectedPrinted = false;
            const markConnectedOnce = async () => {
                if (connectedPrinted) return;
                connectedPrinted = true;
                try {
                    const pong = await client.ping();
                    if (pong === "PONG") {
                        this.redisAvailable = true;
                        console.info("Redis connected");
                        if (QUEUE_LOGS) await this.logQueueStatus();
                    } else {
                        this.redisAvailable = false;
                    }
                } catch {
                    this.redisAvailable = false;
                }
            };

            client.on("connect", () => markConnectedOnce());
            client.on("ready", () => markConnectedOnce());
            client.on("error", () => { this.redisAvailable = false; });

            client.connect().catch(() => { this.redisAvailable = false; });

            this.redis = client;
        } catch {
            this.redisAvailable = false;
            this.redis = null;
        }
    }

    private async logQueueStatus() {
        try {
            if (this.redisAvailable && this.redis) {
                const len = await this.redis.llen(this.QUEUE_KEY);
                const head = await this.redis.lrange(this.QUEUE_KEY, 0, 9);
                console.info(`Queue (redis) length: ${len}`);
                console.info(`Queue (redis) head (first 10 ids): ${JSON.stringify(head)}`);
            } else {
                console.info(`Queue (local) length: ${this.localQueue.length}`);
                console.info(`Queue (local) head (first 10 ids): ${JSON.stringify(this.localQueue.slice(0, 10))}`);
            }
        } catch {
            console.warn("Queue logging failed (non-fatal)");
        }
    }

    async addUser(name: string, socket: Socket) {
        const user: User = { name, socket };
        this.users.push(user);

        if (this.redisAvailable && this.redis) {
            try {
                await this.redis.setex(
                    `${this.USER_DATA_PREFIX}${socket.id}`,
                    this.USER_TTL,
                    JSON.stringify({ name, socketId: socket.id })
                );
                await this.redis.rpush(this.QUEUE_KEY, socket.id);
            } catch {
                this.redisAvailable = false;
                this.localQueue.push(socket.id);
            }
        } else {
            this.localQueue.push(socket.id);
        }

        if (QUEUE_LOGS) await this.logQueueStatus();

        socket.emit("lobby");
        await this.clearQueue();
        this.initHandlers(socket);
    }

    async removeUser(socketId: string) {
        if (this.redisAvailable && this.redis) {
            try {
                await this.redis.lrem(this.QUEUE_KEY, 0, socketId);
                await this.redis.del(`${this.USER_DATA_PREFIX}${socketId}`);
            } catch {
                this.redisAvailable = false;
            }
        }

        this.localQueue = this.localQueue.filter(x => x !== socketId);

        const pair = this.roomManager.removeUserFromRoom(socketId);

        if (pair) {
            const { remainingUser, removedUser } = pair;

            if (remainingUser && remainingUser.socket && remainingUser.socket.connected) {
                if (this.redisAvailable && this.redis) {
                    try {
                        const isInQueue = await this.redis.lpos(this.QUEUE_KEY, remainingUser.socket.id);
                        if (isInQueue === null) {
                            await this.redis.rpush(this.QUEUE_KEY, remainingUser.socket.id);
                            remainingUser.socket.emit("lobby");
                        }
                    } catch {
                        this.redisAvailable = false;
                        if (!this.localQueue.includes(remainingUser.socket.id)) {
                            this.localQueue.push(remainingUser.socket.id);
                            remainingUser.socket.emit("lobby");
                        }
                    }
                } else {
                    if (!this.localQueue.includes(remainingUser.socket.id)) {
                        this.localQueue.push(remainingUser.socket.id);
                        remainingUser.socket.emit("lobby");
                    }
                }
            }

            if (removedUser && removedUser.socket && removedUser.socket.connected) {
                if (this.redisAvailable && this.redis) {
                    try {
                        const isInQueue = await this.redis.lpos(this.QUEUE_KEY, removedUser.socket.id);
                        if (isInQueue === null) {
                            await this.redis.rpush(this.QUEUE_KEY, removedUser.socket.id);
                            removedUser.socket.emit("lobby");
                        }
                    } catch {
                        this.redisAvailable = false;
                        if (!this.localQueue.includes(removedUser.socket.id)) {
                            this.localQueue.push(removedUser.socket.id);
                            removedUser.socket.emit("lobby");
                        }
                    }
                } else {
                    if (!this.localQueue.includes(removedUser.socket.id)) {
                        this.localQueue.push(removedUser.socket.id);
                        removedUser.socket.emit("lobby");
                    }
                }
            }
        }

        this.users = this.users.filter(x => x.socket.id !== socketId);

        if (QUEUE_LOGS) await this.logQueueStatus();

        setTimeout(async () => { await this.clearQueue(); }, 100);
    }

    async clearQueue() {
        if (this.redisAvailable && this.redis) {
            try {
                let remaining = await this.redis.llen(this.QUEUE_KEY);
                while (remaining >= 2) {
                    const pipeline = this.redis.pipeline();
                    pipeline.lpop(this.QUEUE_KEY);
                    pipeline.lpop(this.QUEUE_KEY);

                    const results = await pipeline.exec();
                    if (!results || results.length < 2) break;

                    const id1 = results[0][1] as string | null;
                    const id2 = results[1][1] as string | null;
                    if (!id1 || !id2) break;

                    const user1 = this.users.find(x => x.socket.id === id1);
                    const user2 = this.users.find(x => x.socket.id === id2);

                    if (!user1 || !user2) {
                        if (user1) await this.redis.lpush(this.QUEUE_KEY, user1.socket.id);
                        if (user2) await this.redis.lpush(this.QUEUE_KEY, user2.socket.id);
                        break;
                    }

                    this.roomManager.createRoom(user1, user2);

                    remaining = await this.redis.llen(this.QUEUE_KEY);
                    if (remaining < 2) break;
                }
            } catch {
                this.redisAvailable = false;
                this.clearLocalQueue();
            }
        } else {
            this.clearLocalQueue();
        }

        if (QUEUE_LOGS) await this.logQueueStatus();
    }

    private clearLocalQueue() {
        while (this.localQueue.length >= 2) {
            const id1 = this.localQueue.shift();
            const id2 = this.localQueue.shift();
            if (!id1 || !id2) break;

            const user1 = this.users.find(x => x.socket.id === id1);
            const user2 = this.users.find(x => x.socket.id === id2);

            if (!user1 || !user2) {
                if (user1) this.localQueue.unshift(user1.socket.id);
                if (user2) this.localQueue.unshift(user2.socket.id);
                return;
            }

            this.roomManager.createRoom(user1, user2);
        }
    }

    async getQueueStatus() {
        if (this.redisAvailable && this.redis) {
            try {
                const queueLength = await this.redis.llen(this.QUEUE_KEY);
                const queueUsers = await this.redis.lrange(this.QUEUE_KEY, 0, -1);
                return {
                    length: queueLength,
                    users: queueUsers,
                    activeRooms: this.roomManager.getActiveRooms(),
                    mode: 'redis'
                };
            } catch {
                this.redisAvailable = false;
            }
        }

        return {
            length: this.localQueue.length,
            users: this.localQueue,
            activeRooms: this.roomManager.getActiveRooms(),
            mode: 'local'
        };
    }

    initHandlers(socket: Socket) {
        socket.on("offer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
            this.roomManager.onOffer(roomId, sdp, socket.id);
        });

        socket.on("answer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
            this.roomManager.onAnswer(roomId, sdp, socket.id);
        });

        socket.on("add-ice-candidate", ({ candidate, roomId, type }) => {
            this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
        });

        socket.on("send-message", ({ message, roomId }: { message: string, roomId: string }) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                this.roomManager.onMessage(roomId, socket.id, message, user.name);
            }
        });

        socket.on("typing", ({ isTyping, roomId }: { isTyping: boolean, roomId: string }) => {
            this.roomManager.onTyping(roomId, socket.id, isTyping);
        });

        // Handle reconnection confirmation
        socket.on("confirm-reconnection", async ({ roomId }: { roomId: string }) => {
            // Remove from queue if present
            if (this.redisAvailable && this.redis) {
                try {
                    await this.redis.lrem(this.QUEUE_KEY, 0, socket.id);
                } catch {
                    this.redisAvailable = false;
                }
            }
            this.localQueue = this.localQueue.filter(id => id !== socket.id);

            this.roomManager.confirmReconnection(roomId, socket.id);
        });

        // Handle reconnection decline
        socket.on("decline-reconnection", async ({ roomId }: { roomId: string }) => {
            const otherUser = this.roomManager.declineReconnection(roomId, socket.id);

            // Requeue both users
            if (this.redisAvailable && this.redis) {
                try {
                    const isInQueue = await this.redis.lpos(this.QUEUE_KEY, socket.id);
                    if (isInQueue === null) {
                        await this.redis.rpush(this.QUEUE_KEY, socket.id);
                    }
                    socket.emit("lobby");

                    if (otherUser && otherUser.socket.connected) {
                        const otherInQueue = await this.redis.lpos(this.QUEUE_KEY, otherUser.socket.id);
                        if (otherInQueue === null) {
                            await this.redis.rpush(this.QUEUE_KEY, otherUser.socket.id);
                        }
                        otherUser.socket.emit("lobby");
                    }
                } catch {
                    this.redisAvailable = false;
                    if (!this.localQueue.includes(socket.id)) {
                        this.localQueue.push(socket.id);
                    }
                    socket.emit("lobby");

                    if (otherUser && otherUser.socket.connected && !this.localQueue.includes(otherUser.socket.id)) {
                        this.localQueue.push(otherUser.socket.id);
                        otherUser.socket.emit("lobby");
                    }
                }
            } else {
                if (!this.localQueue.includes(socket.id)) {
                    this.localQueue.push(socket.id);
                }
                socket.emit("lobby");

                if (otherUser && otherUser.socket.connected && !this.localQueue.includes(otherUser.socket.id)) {
                    this.localQueue.push(otherUser.socket.id);
                    otherUser.socket.emit("lobby");
                }
            }

            setTimeout(async () => { await this.clearQueue(); }, 300);
        });

        socket.on("new-chat", async () => {
            const pair = this.roomManager.removeUserFromRoom(socket.id);

            if (this.redisAvailable && this.redis) {
                try {
                    const isInQueue = await this.redis.lpos(this.QUEUE_KEY, socket.id);
                    if (isInQueue === null) {
                        await this.redis.rpush(this.QUEUE_KEY, socket.id);
                        socket.emit("lobby");
                    } else {
                        socket.emit("lobby");
                    }
                } catch {
                    this.redisAvailable = false;
                    if (!this.localQueue.includes(socket.id)) this.localQueue.push(socket.id);
                    socket.emit("lobby");
                }
            } else {
                if (!this.localQueue.includes(socket.id)) this.localQueue.push(socket.id);
                socket.emit("lobby");
            }

            if (pair && pair.remainingUser) {
                const other = pair.remainingUser;
                if (other.socket && other.socket.connected) {
                    if (this.redisAvailable && this.redis) {
                        try {
                            const isInQueue = await this.redis.lpos(this.QUEUE_KEY, other.socket.id);
                            if (isInQueue === null) {
                                await this.redis.rpush(this.QUEUE_KEY, other.socket.id);
                                other.socket.emit("lobby");
                            } else {
                                other.socket.emit("lobby");
                            }
                        } catch {
                            this.redisAvailable = false;
                            if (!this.localQueue.includes(other.socket.id)) {
                                this.localQueue.push(other.socket.id);
                                other.socket.emit("lobby");
                            }
                        }
                    } else {
                        if (!this.localQueue.includes(other.socket.id)) {
                            this.localQueue.push(other.socket.id);
                            other.socket.emit("lobby");
                        }
                    }
                }
            }

            setTimeout(async () => { await this.clearQueue(); }, 300);
        });

        socket.on("join", async ({ name }: { name: string }) => {
            const user = this.users.find(u => u.socket.id === socket.id);
            if (user) {
                user.name = name || "Anonymous";
                if (this.redisAvailable && this.redis) {
                    try {
                        await this.redis.setex(
                            `${this.USER_DATA_PREFIX}${socket.id}`,
                            this.USER_TTL,
                            JSON.stringify({ name: user.name, socketId: socket.id })
                        );
                    } catch {
                        this.redisAvailable = false;
                    }
                }
            }
        });
    }

    async cleanup() {
        if (this.redis) {
            try {
                await this.redis.quit();
            } catch {
                // ignore
            }
        }
    }
}