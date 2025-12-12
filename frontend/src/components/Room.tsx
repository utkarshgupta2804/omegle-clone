import { useEffect, useRef, useState } from "react"
import { type Socket, io } from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Send, SkipForward, Mic, MicOff, Video, VideoOff, AlertCircle } from "lucide-react"

const URL = import.meta.env.VITE_API_URL;

interface Message {
    text: string;
    sender: "you" | "stranger";
    timestamp: Date;
    senderName?: string;
}

export const Room = ({
    name,
    localAudioTrack,
    localVideoTrack,
}: {
    name: string
    localAudioTrack: MediaStreamTrack | null
    localVideoTrack: MediaStreamTrack | null
}) => {
    const [lobby, setLobby] = useState(true)
    const [socket, setSocket] = useState<null | Socket>(null)
    const [sendingPc, setSendingPc] = useState<null | RTCPeerConnection>(null)
    const [receivingPc, setReceivingPc] = useState<null | RTCPeerConnection>(null)
    const [remoteVideoTrack, setRemoteVideoTrack] = useState<MediaStreamTrack | null>(null)
    const [remoteAudioTrack, setRemoteAudioTrack] = useState<MediaStreamTrack | null>(null)
    const [remoteMediaStream, setRemoteMediaStream] = useState<MediaStream | null>(null)
    const remoteVideoRef = useRef<HTMLVideoElement>(null)
    const localVideoRef = useRef<HTMLVideoElement>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)

    const [currentRoomId, setCurrentRoomId] = useState<string | null>(null)
    const [message, setMessage] = useState("")
    const [messages, setMessages] = useState<Message[]>([])
    const [isAudioEnabled, setIsAudioEnabled] = useState(true)
    const [isVideoEnabled, setIsVideoEnabled] = useState(true)
    const [isTyping, setIsTyping] = useState(false)
    const [strangerTyping, setStrangerTyping] = useState(false)
    const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("connecting")

    // Typing timeout ref
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Auto scroll to bottom when new messages arrive
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    // Handle typing indicator
    const handleTyping = () => {
        if (!socket || !currentRoomId) return

        if (!isTyping) {
            setIsTyping(true)
            socket.emit("typing", { isTyping: true, roomId: currentRoomId })
        }

        // Clear existing timeout
        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current)
        }

        // Set new timeout
        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false)
            socket.emit("typing", { isTyping: false, roomId: currentRoomId })
        }, 1000)
    }

    useEffect(() => {
        const socket = io(URL)

        // Emit join event with name
        socket.emit("join", { name })

        socket.on('send-offer', async ({ roomId }) => {
            console.log("sending offer")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            })

            setSendingPc(pc)
            if (localVideoTrack) {
                pc.addTrack(localVideoTrack)
            }
            if (localAudioTrack) {
                pc.addTrack(localAudioTrack)
            }

            pc.onicecandidate = async (e) => {
                if (e.candidate) {
                    socket.emit("add-ice-candidate", {
                        candidate: e.candidate,
                        type: "sender",
                        roomId
                    })
                }
            }

            pc.onnegotiationneeded = async () => {
                const sdp = await pc.createOffer()
                await pc.setLocalDescription(sdp)
                socket.emit("offer", {
                    sdp,
                    roomId
                })
            }

            // If you later add datachannels for other purposes, handle them here.
            pc.ondatachannel = (event) => {
                console.log("📡 Received data channel (currently unused)")
                // Intentionally left blank for now.
            }
        })

        socket.on("offer", async ({ roomId, sdp: remoteSdp }) => {
            console.log("received offer")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            })
            await pc.setRemoteDescription(remoteSdp)
            const sdp = await pc.createAnswer()
            await pc.setLocalDescription(sdp)

            const stream = new MediaStream()
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = stream
            }

            setRemoteMediaStream(stream)
            setReceivingPc(pc)

            pc.ontrack = (e) => {
                console.log("ontrack event received")
            }

            pc.onicecandidate = async (e) => {
                if (!e.candidate) {
                    return
                }
                if (e.candidate) {
                    socket.emit("add-ice-candidate", {
                        candidate: e.candidate,
                        type: "receiver",
                        roomId
                    })
                }
            }

            pc.ondatachannel = (event) => {
                console.log("📡 Received data channel (currently unused)")
            }

            socket.emit("answer", {
                roomId,
                sdp: sdp
            })

            // Wait briefly and attach incoming tracks to remote video element
            setTimeout(() => {
                const transceivers = pc.getTransceivers()
                if (transceivers.length >= 2) {
                    const track1 = transceivers[0].receiver.track
                    const track2 = transceivers[1].receiver.track
                    if (track1.kind === "video") {
                        setRemoteAudioTrack(track2)
                        setRemoteVideoTrack(track1)
                    } else {
                        setRemoteAudioTrack(track1)
                        setRemoteVideoTrack(track2)
                    }
                    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
                        // @ts-ignore
                        remoteVideoRef.current.srcObject.addTrack(track1)
                        // @ts-ignore
                        remoteVideoRef.current.srcObject.addTrack(track2)
                        // @ts-ignore
                        remoteVideoRef.current.play()
                    }
                }
            }, 5000)
        })

        socket.on("answer", ({ roomId, sdp: remoteSdp }) => {
            console.log("✅ Received answer for room:", roomId)
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            setSendingPc(pc => {
                pc?.setRemoteDescription(remoteSdp)
                return pc
            })
            console.log("loop closed")
        })

        socket.on("lobby", () => {
            setLobby(true)
            setConnectionStatus("connecting")
            setCurrentRoomId(null)
            setMessages([])
            setStrangerTyping(false)
        })

        socket.on("add-ice-candidate", ({ candidate, type }) => {
            console.log("add ice candidate from remote", { candidate, type })
            if (type == "sender") {
                setReceivingPc(pc => {
                    pc?.addIceCandidate(candidate)
                    return pc
                })
            } else {
                setSendingPc(pc => {
                    pc?.addIceCandidate(candidate)
                    return pc
                })
            }
        })

        // Handle incoming messages
        socket.on("receive-message", ({ message, sender, senderName, timestamp }) => {
            const newMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(timestamp),
                senderName
            }
            setMessages(prev => [...prev, newMessage])
        })

        // Handle message sent confirmation
        socket.on("message-sent", ({ message, timestamp }) => {
            console.log("Message sent confirmation received")
        })

        // Handle typing indicators
        socket.on("user-typing", ({ isTyping }) => {
            setStrangerTyping(isTyping)
        })

        // Handle user disconnection
        socket.on("user-disconnected", ({ message }) => {
            setConnectionStatus("disconnected")
            const disconnectMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(),
            }
            setMessages(prev => [...prev, disconnectMessage])
            
            // Auto redirect to lobby after 3 seconds
            setTimeout(() => {
                handleNewChat()
            }, 3000)
        })

        setSocket(socket)

        return () => {
            socket.disconnect()
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current)
            }
        }
    }, [name])

    // Setup local video
    useEffect(() => {
        if (localVideoRef.current) {
            if (localVideoTrack) {
                localVideoRef.current.srcObject = new MediaStream([localVideoTrack])
                localVideoRef.current.play()
            }
        }
    }, [localVideoTrack])

    // Handle audio/video toggle
    useEffect(() => {
        if (localAudioTrack) {
            localAudioTrack.enabled = isAudioEnabled
        }
    }, [isAudioEnabled, localAudioTrack])

    useEffect(() => {
        if (localVideoTrack) {
            localVideoTrack.enabled = isVideoEnabled
        }
    }, [isVideoEnabled, localVideoTrack])

    const handleSendMessage = () => {
        if (message.trim() && socket && !lobby) {
            const newMessage: Message = {
                text: message.trim(),
                sender: "you",
                timestamp: new Date(),
            }

            setMessages(prev => [...prev, newMessage])

            // Send message through socket
            socket.emit("send-message", {
                message: message.trim(),
                roomId: currentRoomId
            })

            setMessage("")
            
            // Stop typing indicator
            if (isTyping) {
                setIsTyping(false)
                socket.emit("typing", { isTyping: false, roomId: currentRoomId })
            }
        }
    }

    const handleNewChat = () => {
        // Clean up existing connections
        if (sendingPc) {
            sendingPc.close()
            setSendingPc(null)
        }
        if (receivingPc) {
            receivingPc.close()
            setReceivingPc(null)
        }

        // Clear remote streams
        setRemoteVideoTrack(null)
        setRemoteAudioTrack(null)
        setRemoteMediaStream(null)

        // Clear messages and state
        setMessages([])
        setCurrentRoomId(null)
        setStrangerTyping(false)
        setConnectionStatus("connecting")

        // Reset to lobby
        setLobby(true)

        // Emit new chat request
        if (socket) {
            socket.emit("new-chat")
        }
    }

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setMessage(e.target.value)
        handleTyping()
    }

    const getStatusColor = () => {
        switch (connectionStatus) {
            case "connected": return "text-green-500"
            case "disconnected": return "text-red-500"
            default: return "text-yellow-500"
        }
    }

    const getStatusText = () => {
        switch (connectionStatus) {
            case "connected": return `Connected${name ? ` as ${name}` : ""}`
            case "disconnected": return "Disconnected"
            default: return "Connecting..."
        }
    }

    return (
        <div className="min-h-screen bg-gray-100 flex flex-col">
            {/* Header */}
            <div className="bg-blue-600 text-white p-4">
                <div className="max-w-7xl mx-auto flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-bold">Omegle</h1>
                        <p className={`text-sm ${getStatusColor()}`}>
                            {lobby ? "Looking for someone you can chat with..." : getStatusText()}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            className="bg-white text-blue-600 hover:bg-gray-100"
                            onClick={handleNewChat}
                            disabled={lobby && connectionStatus === "connecting"}
                        >
                            <SkipForward className="w-4 h-4 mr-2" />
                            New Chat
                        </Button>
                    </div>
                </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex max-w-7xl mx-auto w-full">
                {/* Video Section */}
                <div className="flex-1 p-4">
                    <div className={`grid gap-4 h-full grid-cols-1 lg:grid-cols-2`}>
                        {/* Stranger's Video */}
                        <div className="bg-black rounded-lg overflow-hidden relative aspect-video lg:aspect-auto">
                            {lobby ? (
                                <div className="flex items-center justify-center h-full text-white">
                                    <div className="text-center">
                                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
                                        <p>Connecting...</p>
                                    </div>
                                </div>
                            ) : connectionStatus === "disconnected" ? (
                                <div className="flex items-center justify-center h-full text-white">
                                    <div className="text-center">
                                        <AlertCircle className="h-8 w-8 mx-auto mb-4 text-red-400" />
                                        <p>User disconnected</p>
                                        <p className="text-sm text-gray-400 mt-2">Finding new partner...</p>
                                    </div>
                                </div>
                            ) : (
                                <video
                                    autoPlay
                                    playsInline
                                    ref={remoteVideoRef}
                                    className="w-full h-full object-cover"
                                />
                            )}
                            <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                Stranger
                            </div>
                        </div>

                        {/* Your Video */}
                        <div className="bg-black rounded-lg overflow-hidden relative aspect-video lg:aspect-auto">
                            <video
                                autoPlay
                                muted
                                playsInline
                                ref={localVideoRef}
                                className="w-full h-full object-cover"
                            />
                            <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                You
                            </div>

                            {/* Video Controls */}
                            <div className="absolute bottom-2 right-2 flex gap-2">
                                <Button
                                    size="sm"
                                    variant={isAudioEnabled ? "default" : "destructive"}
                                    onClick={() => setIsAudioEnabled(!isAudioEnabled)}
                                >
                                    {isAudioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
                                </Button>
                                <Button
                                    size="sm"
                                    variant={isVideoEnabled ? "default" : "destructive"}
                                    onClick={() => setIsVideoEnabled(!isVideoEnabled)}
                                >
                                    {isVideoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Chat Section */}
                <div className="w-80 bg-white border-l border-gray-200 flex flex-col">
                    {/* Chat Header */}
                    <div className="p-4 border-b border-gray-200">
                        <h3 className="font-semibold text-gray-800">Chat</h3>
                        <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                                connectionStatus === "connected" ? "bg-green-500" : 
                                connectionStatus === "disconnected" ? "bg-red-500" : "bg-yellow-500"
                            }`} />
                            <p className="text-sm text-gray-600">
                                {lobby ? "Waiting for connection..." : 
                                 connectionStatus === "disconnected" ? "Disconnected" : "Connected"}
                            </p>
                        </div>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {messages.length === 0 ? (
                            <div className="text-center text-gray-500 text-sm">
                                {lobby ? "Messages will appear here once connected" : "Start the conversation!"}
                            </div>
                        ) : (
                            messages.map((msg, index) => (
                                <div key={index} className={`${msg.sender === "you" ? "text-right" : "text-left"}`}>
                                    <div
                                        className={`inline-block max-w-xs px-3 py-2 rounded-lg text-sm ${
                                            msg.sender === "you"
                                                ? "bg-blue-600 text-white"
                                                : "bg-gray-200 text-gray-800"
                                        }`}
                                    >
                                        {msg.text}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1">
                                        {msg.sender === "you" ? "You" : (msg.senderName || "Stranger")} • {msg.timestamp.toLocaleTimeString()}
                                    </div>
                                </div>
                            ))
                        )}
                        
                        {/* Typing indicator */}
                        {strangerTyping && (
                            <div className="text-left">
                                <div className="inline-block bg-gray-200 text-gray-800 px-3 py-2 rounded-lg text-sm">
                                    <div className="flex items-center gap-1">
                                        <div className="flex gap-1">
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                                            <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                                        </div>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                    Stranger is typing...
                                </div>
                            </div>
                        )}
                        
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Message Input */}
                    <div className="p-4 border-t border-gray-200">
                        <div className="flex gap-2">
                            <Input
                                placeholder={lobby ? "Wait for connection..." : "Type a message..."}
                                value={message}
                                onChange={handleInputChange}
                                onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                                disabled={lobby || connectionStatus === "disconnected"}
                                className="flex-1"
                                maxLength={500}
                            />
                            <Button
                                onClick={handleSendMessage}
                                disabled={lobby || !message.trim() || connectionStatus === "disconnected"}
                                size="sm"
                            >
                                <Send className="w-4 h-4" />
                            </Button>
                        </div>
                        {message.length > 450 && (
                            <div className="text-xs text-gray-500 mt-1">
                                {500 - message.length} characters remaining
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
