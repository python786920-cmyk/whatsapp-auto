const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const WhatsAppBot = require('./whatsapp-bot');

class WhatsAppBotServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: process.env.ALLOWED_ORIGINS?.split(',') || ["http://localhost:3000"],
                methods: ["GET", "POST"],
                credentials: true
            }
        });
        
        this.bot = null;
        this.activeSessions = new Map();
        this.port = process.env.PORT || 3000;
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupSocketHandlers();
    }

    setupMiddleware() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                    connectSrc: ["'self'", "ws:", "wss:"],
                    imgSrc: ["'self'", "data:", "https:"]
                }
            }
        }));
        
        this.app.use(compression());
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS?.split(',') || ["http://localhost:3000"],
            credentials: true
        }));
        
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Rate limiting
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // limit each IP to 100 requests per windowMs
            message: 'Too many requests, please try again later.',
            standardHeaders: true,
            legacyHeaders: false
        });
        this.app.use(limiter);
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                sessions: this.activeSessions.size,
                memory: process.memoryUsage()
            });
        });

        // API Routes
        this.app.get('/api/status', (req, res) => {
            const botStatus = this.bot ? this.bot.getStatus() : { connected: false };
            res.json({
                bot: botStatus,
                sessions: this.activeSessions.size,
                server: {
                    uptime: process.uptime(),
                    nodeVersion: process.version,
                    platform: process.platform
                }
            });
        });

        this.app.post('/api/send-message', async (req, res) => {
            try {
                const { to, message } = req.body;
                
                if (!this.bot || !this.bot.isReady()) {
                    return res.status(400).json({
                        success: false,
                        error: 'Bot is not connected to WhatsApp'
                    });
                }

                const result = await this.bot.sendMessage(to, message);
                res.json({
                    success: true,
                    data: result
                });
            } catch (error) {
                console.error('Send message error:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        this.app.get('/api/chat-history/:contact', (req, res) => {
            try {
                const { contact } = req.params;
                const history = this.bot ? this.bot.getChatHistory(contact) : [];
                
                res.json({
                    success: true,
                    data: {
                        contact,
                        messages: history
                    }
                });
            } catch (error) {
                console.error('Chat history error:', error);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // API-only server - Frontend hosted separately
        this.app.get('/', (req, res) => {
            res.json({
                message: 'WhatsApp AI Bot API Server',
                status: 'running',
                version: '1.0.0',
                endpoints: {
                    health: '/health',
                    status: '/api/status',
                    sendMessage: '/api/send-message',
                    chatHistory: '/api/chat-history/:contact'
                },
                websocket: 'Socket.io enabled for real-time communication'
            });
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found'
            });
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            console.error('Server error:', err);
            res.status(500).json({
                success: false,
                error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
            });
        });
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`Client connected: ${socket.id}`);

            // Handle session start
            socket.on('start-session', async () => {
                try {
                    console.log('Starting WhatsApp session for client:', socket.id);
                    
                    // Create new bot instance if doesn't exist
                    if (!this.bot) {
                        this.bot = new WhatsAppBot(socket);
                        
                        // Add timeout for initialization
                        const initTimeout = setTimeout(() => {
                            socket.emit('error', 'Bot initialization timeout. Please try again.');
                        }, 60000); // 60 seconds timeout
                        
                        await this.bot.initialize();
                        clearTimeout(initTimeout);
                    } else {
                        // Attach socket to existing bot
                        this.bot.attachSocket(socket);
                    }
                    
                    this.activeSessions.set(socket.id, {
                        startTime: new Date(),
                        bot: this.bot
                    });

                } catch (error) {
                    console.error('Failed to start session:', error);
                    socket.emit('error', `Failed to start session: ${error.message}`);
                }
            });

            // Handle session stop
            socket.on('stop-session', () => {
                console.log('Stopping session for client:', socket.id);
                
                if (this.bot) {
                    this.bot.destroy();
                    this.bot = null;
                }
                
                this.activeSessions.delete(socket.id);
                socket.emit('disconnected', 'Session stopped by user');
            });

            // Handle manual message send
            socket.on('send-message', async (data) => {
                try {
                    const { to, message } = data;
                    
                    if (!this.bot || !this.bot.isReady()) {
                        socket.emit('error', 'Bot is not connected to WhatsApp');
                        return;
                    }

                    await this.bot.sendMessage(to, message);
                    socket.emit('message-sent', { to, message });
                } catch (error) {
                    console.error('Manual send error:', error);
                    socket.emit('error', error.message);
                }
            });

            // Handle get chat history
            socket.on('get-chat-history', (contact) => {
                try {
                    const history = this.bot ? this.bot.getChatHistory(contact) : [];
                    socket.emit('chat-history', { contact, messages: history });
                } catch (error) {
                    console.error('Get chat history error:', error);
                    socket.emit('error', error.message);
                }
            });

            // Handle disconnect
            socket.on('disconnect', (reason) => {
                console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
                this.activeSessions.delete(socket.id);
                
                // If no active sessions, clean up bot
                if (this.activeSessions.size === 0 && this.bot) {
                    setTimeout(() => {
                        if (this.activeSessions.size === 0 && this.bot) {
                            console.log('No active sessions, cleaning up bot...');
                            this.bot.destroy();
                            this.bot = null;
                        }
                    }, 30000); // 30 seconds grace period
                }
            });
        });
    }

    start() {
        this.server.listen(this.port, () => {
            console.log('🚀 WhatsApp AI Bot Server Started!');
            console.log(`📡 Server running on port: ${this.port}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
            console.log(`🔑 Gemini API: ${process.env.GEMINI_API_KEY ? 'Configured ✅' : 'Missing ❌'}`);
            console.log('='.repeat(50));
        });

        // Graceful shutdown
        process.on('SIGTERM', this.shutdown.bind(this));
        process.on('SIGINT', this.shutdown.bind(this));
    }

    async shutdown() {
        console.log('🛑 Shutting down server gracefully...');
        
        // Close all WhatsApp sessions
        if (this.bot) {
            await this.bot.destroy();
        }
        
        // Close server
        this.server.close(() => {
            console.log('✅ Server shut down complete');
            process.exit(0);
        });
    }
}

// Start the server
const server = new WhatsAppBotServer();
server.start();

module.exports = WhatsAppBotServer;
