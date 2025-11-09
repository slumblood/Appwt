import { io } from 'socket.io-client';

class WalkieTalkieApp {
    constructor() {
        this.socket = null;
        this.localStream = null;
        this.peerConnections = {};
        this.roomId = null;
        this.userId = this.generateUserId();
        this.username = '';
        this.isConnected = false;
        
        // Backend URL from environment variable
        this.backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
        
        this.initializeApp();
    }

    generateUserId() {
        return 'user-' + Math.random().toString(36).substr(2, 9);
    }

    async initializeApp() {
        this.setupEventListeners();
        await this.initializeSocket();
    }

    async initializeSocket() {
        try {
            this.socket = io(this.backendUrl, {
                transports: ['websocket', 'polling']
            });

            this.socket.on('connect', () => {
                console.log('Connected to signaling server');
                this.updateStatus('Connected to server');
            });

            this.socket.on('disconnect', () => {
                console.log('Disconnected from signaling server');
                this.updateStatus('Disconnected');
                this.showError('Lost connection to server');
            });

            this.socket.on('user-connected', (userId) => {
                console.log('User connected:', userId);
                this.createPeerConnection(userId);
                this.addUserToList(userId);
            });

            this.socket.on('user-disconnected', (userId) => {
                console.log('User disconnected:', userId);
                this.removePeerConnection(userId);
                this.removeUserFromList(userId);
            });

            this.socket.on('room-users', (users) => {
                console.log('Room users:', users);
                this.updateUsersList(users);
                users.forEach(userId => {
                    if (userId !== this.userId) {
                        this.createPeerConnection(userId);
                    }
                });
            });

            this.socket.on('offer', async (data) => {
                console.log('Received offer from:', data.from);
                await this.handleOffer(data.offer, data.from);
            });

            this.socket.on('answer', async (data) => {
                console.log('Received answer from:', data.from);
                await this.handleAnswer(data.answer, data.from);
            });

            this.socket.on('ice-candidate', async (data) => {
                console.log('Received ICE candidate from:', data.from);
                await this.handleIceCandidate(data.candidate, data.from);
            });

            this.socket.on('user-talking', (data) => {
                this.updateUserTalkingState(data.userId, data.isTalking);
            });

        } catch (error) {
            console.error('Error initializing socket:', error);
            this.showError('Failed to connect to server');
        }
    }

    setupEventListeners() {
        const joinButton = document.getElementById('joinButton');
        const leaveButton = document.getElementById('leaveButton');
        const talkButton = document.getElementById('talkButton');
        const roomInput = document.getElementById('roomInput');
        const usernameInput = document.getElementById('usernameInput');

        joinButton.addEventListener('click', () => this.joinRoom());
        leaveButton.addEventListener('click', () => this.leaveRoom());

        roomInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });

        usernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });

        // Push-to-talk events
        talkButton.addEventListener('mousedown', () => this.startTalking());
        talkButton.addEventListener('mouseup', () => this.stopTalking());
        talkButton.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.startTalking();
        });
        talkButton.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.stopTalking();
        });

        // Prevent context menu on talk button
        talkButton.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    async joinRoom() {
        const roomInput = document.getElementById('roomInput');
        const usernameInput = document.getElementById('usernameInput');
        
        this.roomId = roomInput.value.trim();
        this.username = usernameInput.value.trim() || 'Anonymous';

        if (!this.roomId) {
            this.showError('Please enter a room name');
            return;
        }

        try {
            await this.getMicrophoneAccess();
            
            this.socket.emit('join-room', this.roomId, this.userId);
            
            this.showRoomSection();
            this.updateStatus(`Joined room: ${this.roomId}`);
            
            document.getElementById('roomName').textContent = this.roomId;
            this.addUserToList(this.userId);
            
        } catch (error) {
            console.error('Error joining room:', error);
            this.showError('Failed to join room: ' + error.message);
        }
    }

    leaveRoom() {
        if (this.roomId) {
            this.socket.emit('leave-room', this.roomId, this.userId);
            this.roomId = null;
        }

        // Close all peer connections
        Object.keys(this.peerConnections).forEach(userId => {
            this.removePeerConnection(userId);
        });

        this.showConnectionSection();
        this.updateStatus('Left room');
        
        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
    }

    async getMicrophoneAccess() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            
            // Initially mute the audio
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
            
        } catch (error) {
            console.error('Error accessing microphone:', error);
            throw new Error('Microphone access denied. Please allow microphone permissions.');
        }
    }

    createPeerConnection(userId) {
        if (this.peerConnections[userId]) {
            return this.peerConnections[userId];
        }

        const peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
            ]
        });

        // Add local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, this.localStream);
            });
        }

        // Handle incoming stream
        peerConnection.ontrack = (event) => {
            console.log('Received remote stream from:', userId);
            const audioElement = document.createElement('audio');
            audioElement.srcObject = event.streams[0];
            audioElement.autoplay = true;
            audioElement.volume = 1.0;
            
            // Store audio element for later control
            peerConnection.audioElement = audioElement;
            document.body.appendChild(audioElement);
        };

        // ICE candidate handling
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && this.roomId) {
                this.socket.emit('ice-candidate', {
                    room: this.roomId,
                    candidate: event.candidate,
                    to: userId
                });
            }
        };

        this.peerConnections[userId] = peerConnection;

        // Create offer if we're the second person to join
        this.createOffer(userId);

        return peerConnection;
    }

    async createOffer(userId) {
        try {
            const peerConnection = this.peerConnections[userId];
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            this.socket.emit('offer', {
                room: this.roomId,
                offer: offer,
                to: userId
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    async handleOffer(offer, fromUserId) {
        try {
            const peerConnection = this.createPeerConnection(fromUserId);
            await peerConnection.setRemoteDescription(offer);

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            this.socket.emit('answer', {
                room: this.roomId,
                answer: answer,
                to: fromUserId
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(answer, fromUserId) {
        try {
            const peerConnection = this.peerConnections[fromUserId];
            if (peerConnection) {
                await peerConnection.setRemoteDescription(answer);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(candidate, fromUserId) {
        try {
            const peerConnection = this.peerConnections[fromUserId];
            if (peerConnection) {
                await peerConnection.addIceCandidate(candidate);
            }
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    removePeerConnection(userId) {
        if (this.peerConnections[userId]) {
            // Remove audio element
            if (this.peerConnections[userId].audioElement) {
                this.peerConnections[userId].audioElement.remove();
            }
            
            this.peerConnections[userId].close();
            delete this.peerConnections[userId];
        }
    }

    startTalking() {
        if (this.localStream) {
            // Unmute audio track
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = true;
            });

            // Update UI
            const talkButton = document.getElementById('talkButton');
            talkButton.classList.add('talking');
            talkButton.querySelector('.talk-text').textContent = 'Talking...';

            // Notify other users
            if (this.roomId) {
                this.socket.emit('user-talking', {
                    room: this.roomId,
                    userId: this.userId,
                    isTalking: true
                });
            }
        }
    }

    stopTalking() {
        if (this.localStream) {
            // Mute audio track
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });

            // Update UI
            const talkButton = document.getElementById('talkButton');
            talkButton.classList.remove('talking');
            talkButton.querySelector('.talk-text').textContent = 'Press to Talk';

            // Notify other users
            if (this.roomId) {
                this.socket.emit('user-talking', {
                    room: this.roomId,
                    userId: this.userId,
                    isTalking: false
                });
            }
        }
    }

    updateUserTalkingState(userId, isTalking) {
        // Visual feedback when other users are talking
        const userElement = document.querySelector(`[data-user-id="${userId}"]`);
        if (userElement) {
            userElement.style.backgroundColor = isTalking ? '#d4edda' : '#f8f9fa';
            userElement.style.borderColor = isTalking ? '#c3e6cb' : '#e9ecef';
        }
    }

    addUserToList(userId) {
        const usersList = document.getElementById('usersList');
        const displayName = userId === this.userId ? `${this.username} (You)` : userId;
        
        const userElement = document.createElement('li');
        userElement.textContent = displayName;
        userElement.setAttribute('data-user-id', userId);
        usersList.appendChild(userElement);
    }

    removeUserFromList(userId) {
        const userElement = document.querySelector(`[data-user-id="${userId}"]`);
        if (userElement) {
            userElement.remove();
        }
    }

    updateUsersList(users) {
        const usersList = document.getElementById('usersList');
        usersList.innerHTML = '';
        
        users.forEach(userId => {
            this.addUserToList(userId);
        });
    }

    showRoomSection() {
        document.getElementById('connectionSection').classList.add('hidden');
        document.getElementById('roomSection').classList.remove('hidden');
    }

    showConnectionSection() {
        document.getElementById('roomSection').classList.add('hidden');
        document.getElementById('connectionSection').classList.remove('hidden');
    }

    updateStatus(message) {
        const statusElement = document.getElementById('status');
        statusElement.textContent = message;
    }

    showError(message) {
        const errorSection = document.getElementById('errorSection');
        const errorMessage = document.getElementById('errorMessage');
        
        errorMessage.textContent = message;
        errorSection.classList.remove('hidden');
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideError();
        }, 5000);
    }

    hideError() {
        const errorSection = document.getElementById('errorSection');
        errorSection.classList.add('hidden');
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new WalkieTalkieApp();
});

// Global function for error dismissal
window.hideError = function() {
    const errorSection = document.getElementById('errorSection');
    errorSection.classList.add('hidden');
};