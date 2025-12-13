import { useEffect, useRef, useState } from "react"
import { type Socket, io } from "socket.io-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Send, SkipForward, Mic, MicOff, Video, VideoOff, AlertCircle, LogOut } from "lucide-react"

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

    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const remoteStreamRef = useRef<MediaStream | null>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }

    useEffect(() => {
        scrollToBottom()
    }, [messages])

    const handleTyping = () => {
        if (!socket || !currentRoomId) return

        if (!isTyping) {
            setIsTyping(true)
            socket.emit("typing", { isTyping: true, roomId: currentRoomId })
        }

        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current)
        }

        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false)
            socket.emit("typing", { isTyping: false, roomId: currentRoomId })
        }, 1000)
    }

    useEffect(() => {
        const socket = io(URL)

        socket.emit("join", { name })

        socket.on('send-offer', async ({ roomId }) => {
            console.log("🔵 Sending offer - Setting up peer connection")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            })

            // Create and set up remote stream FIRST
            const stream = new MediaStream()
            remoteStreamRef.current = stream
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = stream
                // Ensure video plays
                remoteVideoRef.current.play().catch(e => console.log("Play error:", e))
            }

            // Handle incoming tracks
            pc.ontrack = (e) => {
                console.log("📹 Received track on sender side:", e.track.kind, "readyState:", e.track.readyState)
                
                const stream = remoteStreamRef.current
                if (!stream) return

                // Remove existing track of same kind if present
                const existingTracks = stream.getTracks().filter(t => t.kind === e.track.kind)
                existingTracks.forEach(t => stream.removeTrack(t))

                // Add new track
                stream.addTrack(e.track)
                
                if (e.track.kind === "video") {
                    setRemoteVideoTrack(e.track)
                } else if (e.track.kind === "audio") {
                    setRemoteAudioTrack(e.track)
                }

                // Re-assign stream to ensure video element picks it up
                if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
                    remoteVideoRef.current.srcObject = stream
                    remoteVideoRef.current.play().catch(e => console.log("Play error:", e))
                }
            }

            // Monitor connection state
            pc.onconnectionstatechange = () => {
                console.log("Connection state:", pc.connectionState)
                if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                    setConnectionStatus("disconnected")
                }
            }

            setSendingPc(pc)
            
            // Add local tracks
            if (localVideoTrack) {
                console.log("➕ Adding local video track")
                pc.addTrack(localVideoTrack)
            }
            if (localAudioTrack) {
                console.log("➕ Adding local audio track")
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
                console.log("🤝 Negotiation needed, creating offer")
                const sdp = await pc.createOffer()
                await pc.setLocalDescription(sdp)
                socket.emit("offer", {
                    sdp,
                    roomId
                })
            }
        })

        socket.on("offer", async ({ roomId, sdp: remoteSdp }) => {
            console.log("🟢 Received offer - Setting up peer connection")
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            
            const pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            })
            
            // Create and set up remote stream FIRST
            const stream = new MediaStream()
            remoteStreamRef.current = stream
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = stream
                remoteVideoRef.current.play().catch(e => console.log("Play error:", e))
            }
            
            // Handle incoming tracks
            pc.ontrack = (e) => {
                console.log("📹 Received track on receiver side:", e.track.kind, "readyState:", e.track.readyState)
                
                const stream = remoteStreamRef.current
                if (!stream) return

                // Remove existing track of same kind if present
                const existingTracks = stream.getTracks().filter(t => t.kind === e.track.kind)
                existingTracks.forEach(t => stream.removeTrack(t))

                // Add new track
                stream.addTrack(e.track)
                
                if (e.track.kind === "video") {
                    setRemoteVideoTrack(e.track)
                } else if (e.track.kind === "audio") {
                    setRemoteAudioTrack(e.track)
                }

                // Re-assign stream to ensure video element picks it up
                if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
                    remoteVideoRef.current.srcObject = stream
                    remoteVideoRef.current.play().catch(e => console.log("Play error:", e))
                }
            }

            // Monitor connection state
            pc.onconnectionstatechange = () => {
                console.log("Connection state:", pc.connectionState)
                if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                    setConnectionStatus("disconnected")
                }
            }

            // Add local tracks BEFORE creating answer
            if (localVideoTrack) {
                console.log("➕ Adding local video track")
                pc.addTrack(localVideoTrack)
            }
            if (localAudioTrack) {
                console.log("➕ Adding local audio track")
                pc.addTrack(localAudioTrack)
            }
            
            await pc.setRemoteDescription(remoteSdp)
            const sdp = await pc.createAnswer()
            await pc.setLocalDescription(sdp)

            setReceivingPc(pc)

            pc.onicecandidate = async (e) => {
                if (e.candidate) {
                    socket.emit("add-ice-candidate", {
                        candidate: e.candidate,
                        type: "receiver",
                        roomId
                    })
                }
            }

            socket.emit("answer", {
                roomId,
                sdp: sdp
            })
        })

        socket.on("answer", ({ roomId, sdp: remoteSdp }) => {
            console.log("✅ Received answer for room:", roomId)
            setLobby(false)
            setCurrentRoomId(roomId)
            setConnectionStatus("connected")
            setSendingPc(pc => {
                if (pc) {
                    console.log("🔗 Setting remote description from answer")
                    pc.setRemoteDescription(remoteSdp)
                }
                return pc
            })
            console.log("🔄 Connection loop closed")
        })

        socket.on("lobby", () => {
            console.log("🏠 Moved to lobby")
            setLobby(true)
            setConnectionStatus("connecting")
            setCurrentRoomId(null)
            setMessages([])
            setStrangerTyping(false)
        })

        socket.on("add-ice-candidate", ({ candidate, type }) => {
            console.log("🧊 Adding ICE candidate:", type)
            if (type == "sender") {
                setReceivingPc(pc => {
                    if (pc) {
                        pc.addIceCandidate(candidate).catch(e => 
                            console.log("Error adding ICE candidate:", e)
                        )
                    }
                    return pc
                })
            } else {
                setSendingPc(pc => {
                    if (pc) {
                        pc.addIceCandidate(candidate).catch(e => 
                            console.log("Error adding ICE candidate:", e)
                        )
                    }
                    return pc
                })
            }
        })

        socket.on("receive-message", ({ message, sender, senderName, timestamp }) => {
            const newMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(timestamp),
                senderName
            }
            setMessages(prev => [...prev, newMessage])
        })

        socket.on("message-sent", ({ message, timestamp }) => {
            console.log("Message sent confirmation received")
        })

        socket.on("user-typing", ({ isTyping }) => {
            setStrangerTyping(isTyping)
        })

        socket.on("user-disconnected", ({ message }) => {
            console.log("👋 User disconnected")
            setConnectionStatus("disconnected")
            const disconnectMessage: Message = {
                text: message,
                sender: "stranger",
                timestamp: new Date(),
            }
            setMessages(prev => [...prev, disconnectMessage])
        })

        setSocket(socket)

        return () => {
            console.log("🔌 Disconnecting socket")
            socket.disconnect()
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current)
            }
        }
    }, [name])

    // Setup local video - separated from socket effect to avoid recreating socket
    useEffect(() => {
        if (localVideoRef.current && localVideoTrack) {
            const stream = new MediaStream([localVideoTrack])
            localVideoRef.current.srcObject = stream
            localVideoRef.current.play().catch(e => console.log("Local video play error:", e))
        }
    }, [localVideoTrack])

    // Handle audio toggle
    useEffect(() => {
        if (localAudioTrack) {
            localAudioTrack.enabled = isAudioEnabled
        }
    }, [isAudioEnabled, localAudioTrack])

    // Handle video toggle
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

            socket.emit("send-message", {
                message: message.trim(),
                roomId: currentRoomId
            })

            setMessage("")
            
            if (isTyping) {
                setIsTyping(false)
                socket.emit("typing", { isTyping: false, roomId: currentRoomId })
            }
        }
    }

    const handleDisconnect = () => {
        console.log("🚪 User initiated disconnect")
        
        // Clean up existing connections
        if (sendingPc) {
            sendingPc.close()
            setSendingPc(null)
        }
        if (receivingPc) {
            receivingPc.close()
            setReceivingPc(null)
        }

        // Clear remote streams and tracks
        setRemoteVideoTrack(null)
        setRemoteAudioTrack(null)
        
        if (remoteStreamRef.current) {
            remoteStreamRef.current.getTracks().forEach(track => track.stop())
            remoteStreamRef.current = null
        }
        
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null
        }

        // Update state to disconnected
        setConnectionStatus("disconnected")
        
        // Add disconnect message to chat
        const disconnectMessage: Message = {
            text: "You have disconnected from this chat.",
            sender: "you",
            timestamp: new Date(),
        }
        setMessages(prev => [...prev, disconnectMessage])

        // Emit disconnect to server
        if (socket) {
            socket.emit("new-chat")
        }
    }

    const handleNewChat = () => {
        console.log("🔄 Starting new chat")
        
        // Clean up existing connections
        if (sendingPc) {
            sendingPc.close()
            setSendingPc(null)
        }
        if (receivingPc) {
            receivingPc.close()
            setReceivingPc(null)
        }

        // Clear remote streams and tracks
        setRemoteVideoTrack(null)
        setRemoteAudioTrack(null)
        
        if (remoteStreamRef.current) {
            remoteStreamRef.current.getTracks().forEach(track => track.stop())
            remoteStreamRef.current = null
        }
        
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null
        }

        // Clear messages and state
        setMessages([])
        setCurrentRoomId(null)
        setStrangerTyping(false)
        setConnectionStatus("connecting")
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
                        {!lobby && connectionStatus === "connected" && (
                            <Button
                                variant="outline"
                                className="bg-red-50 text-red-600 hover:bg-red-100 border-red-200"
                                onClick={handleDisconnect}
                            >
                                <LogOut className="w-4 h-4 mr-2" />
                                Disconnect
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            className="bg-white text-blue-600 hover:bg-gray-100"
                            onClick={handleNewChat}
                            disabled={lobby && connectionStatus === "connecting"}
                        >
                            <SkipForward className="w-4 h-4 mr-2" />
                            {connectionStatus === "disconnected" ? "Find New Partner" : "New Chat"}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Main Chat Area */}
            <div className="flex-1 flex max-w-7xl mx-auto w-full">
                {/* Video Section */}
                <div className="flex-1 p-4">
                    <div className="grid gap-4 h-full grid-cols-1 lg:grid-cols-2">
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
                                        <p className="text-sm text-gray-400 mt-2">Click "Find New Partner" to continue</p>
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