const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const GeminiAI = require('./gemini');

class WhatsAppManager {
    constructor(sessionId, io, socket = null) {
        this.sessionId = sessionId;
        this.io = io;
        this.socket = socket;
        this.client = null;
        this.isReady = false;
        this.status = 'initializing';
        this.createdAt = new Date();
        this.geminiAI = new GeminiAI();
        this.messageStats = {
            received: 0,
            sent: 0,
            errors: 0
        };
        this.chatHistory = new Map(); // Store chat history per contact
        this.typingDelay = {
            min: 1000,
            max: 3000,
            perChar: 50
        };
    }

    async initialize() {
        try {
            console.log(`🔄 Initializing WhatsApp client for session: ${this.sessionId}`);
            
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: this.sessionId,
                    dataPath: './sessions'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu'
                    ]
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                }
            });

            this.setupEventListeners();
            await this.client.initialize();
            
        } catch (error) {
            console.error(`❌ Error initializing WhatsApp client:`, error);
            this.emitError(error.message);
            throw error;
        }
    }

    setupEventListeners() {
        // QR Code generation
        this.client.on('qr', async (qr) => {
            console.log(`📱 QR Code generated for session: ${this.sessionId}`);
            try {
                const qrImage = await qrcode.toDataURL(qr);
                this.status = 'qr_generated';
                this.emitToSocket('qr', qrImage);
            } catch (error) {
                console.error('Error generating QR code:', error);
                this.emitError('Failed to generate QR code');
            }
        });

        // Authentication success
        this.client.on('authenticated', () => {
            console.log(`✅ WhatsApp authenticated for session: ${this.sessionId}`);
            this.status = 'authenticated';
            this.emitToSocket('authenticated');
        });

        // Authentication failure
        this.client.on('auth_failure', (msg) => {
            console.error(`❌ Authentication failed for session: ${this.sessionId}`, msg);
            this.status = 'auth_failed';
            this.emitError(`Authentication failed: ${msg}`);
        });

        // Client ready
        this.client.on('ready', () => {
            console.log(`🚀 WhatsApp client ready for session: ${this.sessionId}`);
            this.isReady = true;
            this.status = 'ready';
            this.emitToSocket('ready', this.sessionId);
        });

        // Disconnected
        this.client.on('disconnected', (reason) => {
            console.log(`🔌 WhatsApp disconnected for session: ${this.sessionId}, Reason: ${reason}`);
            this.isReady = false;
            this.status = 'disconnected';
            this.emitToSocket('disconnected', reason);
        });

        // Message received
        this.client.on('message', async (message) => {
            await this.handleIncomingMessage(message);
        });

        // Message creation (sent)
        this.client.on('message_create', async (message) => {
            if (message.fromMe) {
                this.messageStats.sent++;
                this.emitToSocket('message_sent', { 
                    to: message.to,
                    body: message.body,
                    timestamp: message.timestamp 
                });
            }
        });

        // Error handling
        this.client.on('error', (error) => {
            console.error(`❌ WhatsApp client error for session: ${this.sessionId}`, error);
            this.messageStats.errors++;
            this.emitError(error.message);
        });
    }

    async handleIncomingMessage(message) {
        try {
            // Skip if message is from me, from status updates, or from groups (optional)
            if (message.fromMe || message.from === 'status@broadcast') {
                return;
            }

            console.log(`📨 New message from ${message.from}: ${message.body}`);
            this.messageStats.received++;
            this.emitToSocket('message_received', {
                from: message.from,
                body: message.body,
                timestamp: message.timestamp
            });

            // Get contact info
            const contact = await message.getContact();
            const contactName = contact.name || contact.pushname || message.from;

            // Update chat history
            this.updateChatHistory(message.from, message.body, false);

            // Generate AI response
            const aiResponse = await this.generateAIResponse(message.body, message.from, contactName);
            
            if (aiResponse) {
                // Simulate human typing
                await this.simulateTyping(message.from, aiResponse);
                
                // Send response
                await this.sendMessage(message.from, aiResponse);
                
                // Update chat history with bot response
                this.updateChatHistory(message.from, aiResponse, true);
            }

        } catch (error) {
            console.error('Error handling incoming message:', error);
            this.messageStats.errors++;
            
            // Send fallback message
            const fallbackMessage = this.getFallbackMessage();
            await this.sendMessage(message.from, fallbackMessage).catch(console.error);
        }
    }

    updateChatHistory(contactId, message, isBot = false) {
        if (!this.chatHistory.has(contactId)) {
            this.chatHistory.set(contactId, []);
        }
        
        const history = this.chatHistory.get(contactId);
        history.push({
            message,
            isBot,
            timestamp: new Date()
        });
        
        // Keep only last 10 messages per contact
        if (history.length > 10) {
            history.shift();
        }
    }

    getChatHistory(contactId) {
        return this.chatHistory.get(contactId) || [];
    }

    async generateAIResponse(userMessage, contactId, contactName) {
        try {
            const chatHistory = this.getChatHistory(contactId);
            const response = await this.geminiAI.generateResponse(
                userMessage, 
                contactName, 
                chatHistory
            );
            return response;
        } catch (error) {
            console.error('Error generating AI response:', error);
            return this.getFallbackMessage();
        }
    }

    getFallbackMessage() {
        const fallbackMessages = [
            "Sorry yaar, thoda issue ho gaya. Tum bolo kya chahiye?",
            "Arre yar, kuch technical problem aa gaya. Main thodi der mein reply karunga!",
            "Bhai, abhi thoda busy hun. Baad mein baat karte hain!",
            "Hmm, samajh nahi aaya. Phir se bologe?",
            "Thoda internet slow hai, baad mein reply karunga bro!"
        ];
        
        return fallbackMessages[Math.floor(Math.random() * fallbackMessages.length)];
    }

    async simulateTyping(chatId, message) {
        try {
            const chat = await this.client.getChatById(chatId);
            
            // Start typing indicator
            await chat.sendStateTyping();
            
            // Calculate typing delay based on message length
            const baseDelay = Math.random() * (this.typingDelay.max - this.typingDelay.min) + this.typingDelay.min;
            const charDelay = message.length * this.typingDelay.perChar;
            const totalDelay = Math.min(baseDelay + charDelay, 5000); // Max 5 seconds
            
            // Wait for typing simulation
            await new Promise(resolve => setTimeout(resolve, totalDelay));
            
            // Clear typing indicator
            await chat.clearState();
            
        } catch (error) {
            console.error('Error simulating typing:', error);
            // Add small delay even if typing simulation fails
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    async sendMessage(to, message) {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client not ready');
            }

            await this.client.sendMessage(to, message);
            console.log(`📤 Message sent to ${to}: ${message.substring(0, 50)}...`);
            return true;
            
        } catch (error) {
            console.error(`❌ Error sending message to ${to}:`, error);
            throw error;
        }
    }

    async sendMediaMessage(to, media, caption = '') {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client not ready');
            }

            const messageMedia = new MessageMedia(media.mimetype, media.data, media.filename);
            await this.client.sendMessage(to, messageMedia, { caption });
            console.log(`📤 Media sent to ${to}`);
            return true;
            
        } catch (error) {
            console.error(`❌ Error sending media to ${to}:`, error);
            throw error;
        }
    }

    async getChats() {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client not ready');
            }
            
            const chats = await this.client.getChats();
            return chats.map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                isGroup: chat.isGroup,
                timestamp: chat.timestamp
            }));
            
        } catch (error) {
            console.error('Error getting chats:', error);
            throw error;
        }
    }

    emitToSocket(event, data = null) {
        if (this.socket) {
            this.socket.emit(event, data);
        }
        
        // Also emit to all clients in the room
        if (this.io) {
            this.io.emit(event, data);
        }
    }

    emitError(message) {
        this.emitToSocket('error', message);
    }

    getStats() {
        return {
            sessionId: this.sessionId,
            isReady: this.isReady,
            status: this.status,
            createdAt: this.createdAt,
            messageStats: this.messageStats,
            chatHistoryCount: this.chatHistory.size
        };
    }

    async destroy() {
        try {
            console.log(`🔄 Destroying WhatsApp client for session: ${this.sessionId}`);
            
            if (this.client) {
                await this.client.destroy();
                this.client = null;
            }
            
            this.isReady = false;
            this.status = 'destroyed';
            this.chatHistory.clear();
            
            console.log(`✅ WhatsApp client destroyed for session: ${this.sessionId}`);
            
        } catch (error) {
            console.error(`❌ Error destroying WhatsApp client for session: ${this.sessionId}`, error);
            throw error;
        }
    }
}

module.exports = WhatsAppManager;
