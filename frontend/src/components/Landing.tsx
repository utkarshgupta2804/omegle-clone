"use client"

import { useEffect, useRef, useState } from "react"
import { Room } from "./Room"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AlertCircle, Video } from "lucide-react"

export const Landing = () => {
    const [name, setName] = useState("")
    const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null)
    const [localVideoTrack, setlocalVideoTrack] = useState<MediaStreamTrack | null>(null)
    const videoRef = useRef<HTMLVideoElement>(null)
    const [joined, setJoined] = useState(false)
    const [cameraError, setCameraError] = useState<string | null>(null)
    const [isLoadingCamera, setIsLoadingCamera] = useState(false)

    const getCam = async () => {
        try {
            setIsLoadingCamera(true)
            setCameraError(null)
            
            const stream = await window.navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
            })
            
            const audioTrack = stream.getAudioTracks()[0]
            const videoTrack = stream.getVideoTracks()[0]
            
            setLocalAudioTrack(audioTrack)
            setlocalVideoTrack(videoTrack)
            
            if (videoRef.current) {
                videoRef.current.srcObject = new MediaStream([videoTrack])
                videoRef.current.play().catch(error => {
                    console.error("Error playing video:", error)
                })
            }
            
            console.log("Camera and microphone access granted")
        } catch (error) {
            console.error("Error accessing camera/microphone:", error)
            setCameraError(
                error instanceof Error && error.name === "NotAllowedError"
                    ? "Camera and microphone access denied. Please allow access to continue."
                    : "Failed to access camera/microphone. Please check your device settings."
            )
        } finally {
            setIsLoadingCamera(false)
        }
    }

    // Fix: Remove dependency array to run immediately, then check for videoRef
    useEffect(() => {
        getCam()
    }, [])

    // Update video element when track changes
    useEffect(() => {
        if (videoRef.current && localVideoTrack) {
            videoRef.current.srcObject = new MediaStream([localVideoTrack])
            videoRef.current.play().catch(error => {
                console.error("Error playing video:", error)
            })
        }
    }, [localVideoTrack])

    const handleStartChat = () => {
        if (!localVideoTrack || !localAudioTrack) {
            setCameraError("Please allow camera and microphone access to start chatting")
            return
        }
        setJoined(true)
    }

    if (!joined) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-blue-600 to-blue-800 flex flex-col">
                {/* Header */}
                <div className="bg-white shadow-sm">
                    <div className="max-w-4xl mx-auto px-4 py-3">
                        <h1 className="text-2xl font-bold text-blue-600">Omegle</h1>
                        <p className="text-sm text-gray-600">Talk to strangers!</p>
                    </div>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex items-center justify-center p-4">
                    <div className="bg-white rounded-lg shadow-xl p-8 max-w-md w-full">
                        <div className="text-center mb-6">
                            <h2 className="text-xl font-semibold text-gray-800 mb-2">Start chatting</h2>
                            <p className="text-gray-600 text-sm">You'll be connected to a random stranger</p>
                        </div>

                        {/* Video Preview */}
                        <div className="mb-6">
                            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
                                {isLoadingCamera ? (
                                    <div className="flex items-center justify-center h-full text-white">
                                        <div className="text-center">
                                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4"></div>
                                            <p className="text-sm">Accessing camera...</p>
                                        </div>
                                    </div>
                                ) : cameraError ? (
                                    <div className="flex items-center justify-center h-full text-white p-4">
                                        <div className="text-center">
                                            <AlertCircle className="h-8 w-8 mx-auto mb-4 text-red-400" />
                                            <p className="text-sm text-center">{cameraError}</p>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="mt-4 text-blue-600 border-blue-600 hover:bg-blue-600 hover:text-white"
                                                onClick={getCam}
                                            >
                                                <Video className="w-4 h-4 mr-2" />
                                                Try Again
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <video 
                                        autoPlay 
                                        muted 
                                        ref={videoRef} 
                                        className="w-full h-full object-cover" 
                                    />
                                )}
                                <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                                    You
                                </div>
                            </div>
                        </div>

                        {/* Name Input */}
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Your name (optional)
                            </label>
                            <Input
                                type="text"
                                placeholder="Enter your name..."
                                value={name}
                                onChange={(e) => setName(e.target.value.slice(0, 50))} // Limit to 50 chars
                                className="w-full"
                                maxLength={50}
                            />
                            {name.length > 40 && (
                                <div className="text-xs text-gray-500 mt-1">
                                    {50 - name.length} characters remaining
                                </div>
                            )}
                        </div>

                        {/* Start Button */}
                        <Button
                            onClick={handleStartChat}
                            disabled={isLoadingCamera || !!cameraError}
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 disabled:bg-gray-400 disabled:cursor-not-allowed"
                            size="lg"
                        >
                            {isLoadingCamera ? (
                                <>
                                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                                    Loading...
                                </>
                            ) : (
                                "Start Video Chat"
                            )}
                        </Button>

                        {/* Instructions */}
                        <div className="mt-6 space-y-2">
                            <div className="flex items-center gap-2 text-xs text-gray-600">
                                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                <span>Camera and microphone access required</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-600">
                                <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                                <span>You can chat via text and video</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-600">
                                <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                                <span>Click "New Chat" to find someone new</span>
                            </div>
                        </div>

                        <p className="text-xs text-gray-500 text-center mt-6">
                            By clicking "Start Video Chat", you agree to our terms and conditions
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <Room 
            name={name || "Anonymous"} 
            localAudioTrack={localAudioTrack} 
            localVideoTrack={localVideoTrack} 
        />
    )
}