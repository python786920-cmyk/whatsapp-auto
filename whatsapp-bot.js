const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');

class WhatsAppBot {
    constructor(socket) {
        this.socket = socket;
        this.client = null;
        this.genAI = null;
        this.model = null;
        this.isInitialized = false;
        this.isReady = false;
        this.messageCount = 0;
        this.chatHistory = new Map(); // Store chat history per contact
        this.rateLimiter = new Map(); // Rate limiting per contact
        this.userSessions = new Map(); // AI conversation sessions
        
        // Configuration
        this.config = {
            maxHistoryLength: 10,
            responseDelayMin: parseInt(process.env.RESPONSE_DELAY_MIN) || 1000,
            responseDelayMax: parseInt(process.env.RESPONSE_DELAY_MAX) || 3000,
            maxMessagesPerMinute: parseInt(process.env.MAX_MESSAGES_PER_MINUTE) || 2,
            sessionName: process.env.SESSION_NAME || 'whatsapp_session_main',
            botName: process.env.BOT_NAME || 'AI Assistant'
        };

        // Data directories
        this.dataDir = path.join(__dirname, 'data');
        this.sessionsDir = path.join(this.dataDir, 'sessions');
        this.historyFile = path.join(this.dataDir, 'chat_history.json');
        
        this.setupDirectories();
        this.setupAI();
        this.setupCleanupTasks();
    }

    async setupDirectories() {
        try {
            await fs.ensureDir(this.dataDir);
            await fs.ensureDir(this.sessionsDir);
            
            // Load existing chat history
            if (await fs.pathExists(this.historyFile)) {
                const historyData = await fs.readJSON(this.historyFile);
                this.chatHistory = new Map(Object.entries(historyData));
            }
        } catch (error) {
            console.error('Setup directories error:', error);
        }
    }

    setupAI() {
        try {
            if (!process.env.GEMINI_API_KEY) {
                throw new Error('GEMINI_API_KEY not found in environment variables');
            }
            
            this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
            
            console.log('✅ Google Gemini AI initialized successfully');
        } catch (error) {
            console.error('❌ AI setup error:', error);
            this.socket?.emit('error', 'AI initialization failed: ' + error.message);
        }
    }

    setupCleanupTasks() {
        // Clean up old rate limit data every hour
        cron.schedule('0 * * * *', () => {
            this.cleanupRateLimiter();
        });

        // Save chat history every 5 minutes
        cron.schedule('*/5 * * * *', () => {
            this.saveChatHistory();
        });
    }

    async initialize() {
        try {
            console.log('🤖 Initializing WhatsApp Bot...');
            
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: this.config.sessionName,
                    dataPath: this.sessionsDir
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
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                        '--disable-extensions'
                    ],
                    executablePath: process.env.NODE_ENV === 'production' 
                        ? process.env.PUPPETEER_EXECUTABLE_PATH 
                        : undefined
                }
            });

            this.setupEventHandlers();
            await this.client.initialize();
            this.isInitialized = true;
            
        } catch (error) {
            console.error('❌ Bot initialization error:', error);
            this.socket?.emit('error', 'Failed to initialize WhatsApp client: ' + error.message);
            throw error;
        }
    }

    setupEventHandlers() {
        // QR Code generation
        this.client.on('qr', async (qr) => {
            try {
                console.log('📱 QR Code generated, sending to frontend...');
                const qrImage = await QRCode.toDataURL(qr);
                this.socket?.emit('qr', qrImage);
            } catch (error) {
                console.error('QR Code generation error:', error);
                this.socket?.emit('error', 'QR code generation failed');
            }
        });

        // Authentication events
        this.client.on('authenticated', () => {
            console.log('✅ WhatsApp authenticated successfully');
            this.socket?.emit('authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('❌ Authentication failed:', msg);
            this.socket?.emit('auth_failure', msg);
        });

        // Ready event
        this.client.on('ready', () => {
            console.log('🚀 WhatsApp Bot is ready and connected!');
            this.isReady = true;
            this.socket?.emit('ready');
        });

        // Message handling
        this.client.on('message', async (message) => {
            try {
                await this.handleIncomingMessage(message);
            } catch (error) {
                console.error('Message handling error:', error);
            }
        });

        // Disconnection handling
        this.client.on('disconnected', (reason) => {
            console.log('📱 WhatsApp disconnected:', reason);
            this.isReady = false;
            this.socket?.emit('disconnected', reason);
        });

        // Error handling
        this.client.on('error', (error) => {
            console.error('WhatsApp client error:', error);
            this.socket?.emit('error', error.message);
        });
    }

    async handleIncomingMessage(message) {
        try {
            // Skip if message is from status broadcast or groups (optional)
            if (message.from === 'status@broadcast') return;
            
            // Skip if message is from self
            if (message.fromMe) return;

            // Get contact info
            const contact = await message.getContact();
            const contactName = contact.pushname || contact.name || message.from;
            const contactId = message.from;

            console.log(`📨 New message from ${contactName}: ${message.body}`);

            // Update message count
            this.messageCount++;
            
            // Check rate limiting
            if (!this.checkRateLimit(contactId)) {
                console.log(`⏳ Rate limited for ${contactName}`);
                return;
            }

            // Store message in history
            this.addToHistory(contactId, {
                type: 'received',
                message: message.body,
                timestamp: new Date(),
                from: contactName
            });

            // Send to frontend
            this.socket?.emit('message', {
                from: contactName,
                body: message.body,
                timestamp: new Date(),
                fromMe: false
            });

            // Generate AI response
            await this.generateAndSendResponse(message, contactId, contactName);

        } catch (error) {
            console.error('Handle incoming message error:', error);
        }
    }

    async generateAndSendResponse(message, contactId, contactName) {
        try {
            // Show typing indicator
            await this.client.sendPresenceAvailable();
            await message.getChat().then(chat => chat.sendStateTyping());

            // Get conversation history for context
            const history = this.getConversationContext(contactId);
            
            // Generate AI response
            const aiResponse = await this.getAIResponse(message.body, history, contactName);
            
            if (!aiResponse) {
                console.log('No AI response generated');
                return;
            }

            // Calculate typing delay (simulate human typing)
            const typingDelay = this.calculateTypingDelay(aiResponse);
            
            // Wait for typing simulation
            await this.sleep(typingDelay);

            // Clear typing indicator and send response
            await message.getChat().then(chat => chat.clearState());
            const sentMessage = await message.reply(aiResponse);

            // Store sent message in history
            this.addToHistory(contactId, {
                type: 'sent',
                message: aiResponse,
                timestamp: new Date(),
                to: contactName
            });

            // Update rate limiter
            this.updateRateLimit(contactId);

            // Send to frontend
            this.socket?.emit('message', {
                from: this.config.botName,
                body: aiResponse,
                timestamp: new Date(),
                fromMe: true
            });

            console.log(`✅ Response sent to ${contactName}: ${aiResponse.substring(0, 50)}...`);

        } catch (error) {
            console.error('Generate response error:', error);
            
            // Send fallback response
            const fallbackResponse = this.getFallbackResponse();
            try {
                await message.reply(fallbackResponse);
                this.addToHistory(contactId, {
                    type: 'sent',
                    message: fallbackResponse,
                    timestamp: new Date(),
                    to: contactName
                });
            } catch (fallbackError) {
                console.error('Fallback response error:', fallbackError);
            }
        }
    }

    async getAIResponse(messageText, conversationHistory, contactName) {
        try {
            if (!this.model) {
                throw new Error('AI model not initialized');
            }

            // Detect language from the message
            const detectedLanguage = this.detectLanguage(messageText);
            
            // Build context-aware prompt
            const prompt = this.buildAIPrompt(messageText, conversationHistory, contactName, detectedLanguage);

            // Generate response
            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const aiReply = response.text();

            return this.cleanAIResponse(aiReply);

        } catch (error) {
            console.error('AI response generation error:', error);
            return null;
        }
    }

    buildAIPrompt(message, history, contactName, language) {
        const languageInstructions = {
            hindi: "हिंदी में जवाब दो। बिल्कुल natural और friendly tone में बात करो।",
            english: "Reply in English. Keep it natural and friendly like talking to a close friend.",
            hinglish: "Hinglish mein reply karo. Natural aur friendly tone rakhna, jaise koi dost se baat kar raha ho."
        };

        const instruction = languageInstructions[language] || languageInstructions.hinglish;

        return `तुम एक WhatsApp पर chat करने वाले smart और friendly AI assistant हो। ${contactName} नाम का व्यक्ति तुमसे बात कर रहा है।

${instruction}

IMPORTANT RULES:
- बहुत ज्यादा लंबा message मत भेजो (maximum 2-3 sentences)
- Emojis का इस्तेमाल करो but बहुत ज्यादा नहीं
- Natural conversation करो, robot जैसा मत लगो
- अगर कोई personal या sensitive question पूछे तो politely avoid करो
- हमेशा helpful और positive रहो

${history.length > 0 ? `पिछली conversation:
${history.map(h => `${h.type === 'received' ? contactName : 'You'}: ${h.message}`).join('\n')}` : ''}

${contactName} का नया message: "${message}"

अब तुम्हारा reply (सिर्फ message content, कोई extra text नहीं):`;
    }

    detectLanguage(text) {
        const hindiPattern = /[\u0900-\u097F]/;
        const englishPattern = /^[a-zA-Z0-9\s.,!?'"()-]+$/;
        
        if (hindiPattern.test(text)) {
            return 'hindi';
        } else if (englishPattern.test(text)) {
            return 'english';
        } else {
            return 'hinglish';
        }
    }

    cleanAIResponse(response) {
        // Clean up the AI response
        return response
            .replace(/^(You:|Me:|AI:|Bot:|Assistant:)/i, '')
            .replace(/^["']|["']$/g, '')
            .trim();
    }

    getFallbackResponse() {
        const fallbacks = [
            "Sorry yaar, thoda issue ho gaya. Kya keh rahe the tum? 🤔",
            "Oops! Kuch technical problem hai. Dobara try karo 😅",
            "Hmm, samajh nahi aaya. Thoda aur detail mein batao? 🤷‍♂️",
            "Sorry bro, connection issue. Kya bol rahe the? 📱",
            "Arre yaar, kuch gadbad hai. Phir se message karo 🔄"
        ];
        
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    getConversationContext(contactId) {
        const history = this.chatHistory.get(contactId) || [];
        return history.slice(-6); // Last 6 messages for context
    }

    addToHistory(contactId, messageData) {
        if (!this.chatHistory.has(contactId)) {
            this.chatHistory.set(contactId, []);
        }
        
        const history = this.chatHistory.get(contactId);
        history.push(messageData);
        
        // Keep only last N messages
        if (history.length > this.config.maxHistoryLength) {
            history.shift();
        }
    }

    checkRateLimit(contactId) {
        const now = Date.now();
        const windowMs = 60 * 1000; // 1 minute
        
        if (!this.rateLimiter.has(contactId)) {
            this.rateLimiter.set(contactId, []);
        }
        
        const requests = this.rateLimiter.get(contactId);
        
        // Remove old requests outside the window
        const validRequests = requests.filter(time => now - time < windowMs);
        this.rateLimiter.set(contactId, validRequests);
        
        return validRequests.length < this.config.maxMessagesPerMinute;
    }

    updateRateLimit(contactId) {
        const now = Date.now();
        if (!this.rateLimiter.has(contactId)) {
            this.rateLimiter.set(contactId, []);
        }
        this.rateLimiter.get(contactId).push(now);
    }

    cleanupRateLimiter() {
        const now = Date.now();
        const windowMs = 60 * 1000; // 1 minute
        
        for (const [contactId, requests] of this.rateLimiter.entries()) {
            const validRequests = requests.filter(time => now - time < windowMs);
            if (validRequests.length === 0) {
                this.rateLimiter.delete(contactId);
            } else {
                this.rateLimiter.set(contactId, validRequests);
            }
        }
    }

    calculateTypingDelay(message) {
        const baseDelay = this.config.responseDelayMin;
        const maxDelay = this.config.responseDelayMax;
        const typingSpeed = 30; // ms per character
        
        const calculatedDelay = Math.min(message.length * typingSpeed, maxDelay);
        const randomDelay = baseDelay + Math.random() * (calculatedDelay - baseDelay);
        
        return Math.floor(randomDelay);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async saveChatHistory() {
        try {
            const historyObject = Object.fromEntries(this.chatHistory);
            await fs.writeJSON(this.historyFile, historyObject, { spaces: 2 });
            console.log('💾 Chat history saved');
        } catch (error) {
            console.error('Save chat history error:', error);
        }
    }

    // Public methods
    attachSocket(socket) {
        this.socket = socket;
    }

    getStatus() {
        return {
            connected: this.isReady,
            initialized: this.isInitialized,
            messageCount: this.messageCount,
            activeChats: this.chatHistory.size,
            rateLimitedContacts: this.rateLimiter.size
        };
    }

    isReady() {
        return this.isReady;
    }

    getChatHistory(contactId) {
        return this.chatHistory.get(contactId) || [];
    }

    async sendMessage(to, message) {
        if (!this.isReady) {
            throw new Error('Bot is not ready');
        }
        
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        return await this.client.sendMessage(chatId, message);
    }

    async destroy() {
        try {
            console.log('🛑 Destroying WhatsApp Bot...');
            
            // Save chat history before destroying
            await this.saveChatHistory();
            
            if (this.client) {
                await this.client.destroy();
                this.client = null;
            }
            
            this.isReady = false;
            this.isInitialized = false;
            
            console.log('✅ WhatsApp Bot destroyed successfully');
        } catch (error) {
            console.error('Destroy bot error:', error);
        }
    }
}

module.exports = WhatsAppBot;
