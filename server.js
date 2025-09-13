const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const WhatsAppManager = require('./whatsapp');
const SessionManager = require('./sessionManager');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Middleware
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// Global variables
const sessionManager = new SessionManager();
const whatsappInstances = new Map();

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'WhatsApp Auto Bot Server Running',
        timestamp: new Date().toISOString(),
        activeSessions: whatsappInstances.size,
        version: '1.0.0'
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    const sessions = [];
    whatsappInstances.forEach((instance, sessionId) => {
        sessions.push({
            sessionId,
            isReady: instance.isReady,
            status: instance.status,
            createdAt: instance.createdAt
        });
    });
    
    res.json({
        totalSessions: sessions.length,
        sessions
    });
});

app.post('/api/create-session', async (req, res) => {
    try {
        const sessionId = sessionManager.generateSessionId();
        const whatsappManager = new WhatsAppManager(sessionId, io);
        
        whatsappInstances.set(sessionId, whatsappManager);
        await whatsappManager.initialize();
        
        res.json({
            success: true,
            sessionId,
            message: 'Session created successfully'
        });
    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create session',
            error: error.message
        });
    }
});

app.delete('/api/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const instance = whatsappInstances.get(sessionId);
        
        if (!instance) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        await instance.destroy();
        whatsappInstances.delete(sessionId);
        
        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete session',
            error: error.message
        });
    }
});

app.post('/api/send-message', async (req, res) => {
    try {
        const { sessionId, to, message } = req.body;
        
        if (!sessionId || !to || !message) {
            return res.status(400).json({
                success: false,
                message: 'sessionId, to, and message are required'
            });
        }
        
        const instance = whatsappInstances.get(sessionId);
        if (!instance || !instance.isReady) {
            return res.status(404).json({
                success: false,
                message: 'Session not found or not ready'
            });
        }
        
        await instance.sendMessage(to, message);
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message',
            error: error.message
        });
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`🔗 Client connected: ${socket.id}`);
    
    socket.on('start_session', async () => {
        try {
            const sessionId = sessionManager.generateSessionId();
            const whatsappManager = new WhatsAppManager(sessionId, io, socket);
            
            whatsappInstances.set(sessionId, whatsappManager);
            socket.sessionId = sessionId;
            
            console.log(`🚀 Starting session: ${sessionId}`);
            await whatsappManager.initialize();
            
        } catch (error) {
            console.error('Error starting session:', error);
            socket.emit('error', error.message);
        }
    });
    
    socket.on('stop_session', async () => {
        try {
            if (socket.sessionId) {
                const instance = whatsappInstances.get(socket.sessionId);
                if (instance) {
                    await instance.destroy();
                    whatsappInstances.delete(socket.sessionId);
                    console.log(`🛑 Session stopped: ${socket.sessionId}`);
                }
                socket.sessionId = null;
            }
        } catch (error) {
            console.error('Error stopping session:', error);
            socket.emit('error', error.message);
        }
    });
    
    socket.on('disconnect', async (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id}, Reason: ${reason}`);
        
        if (socket.sessionId) {
            const instance = whatsappInstances.get(socket.sessionId);
            if (instance) {
                // Don't destroy on disconnect, keep session alive
                console.log(`⏸️  Session paused: ${socket.sessionId}`);
            }
        }
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM received, shutting down gracefully...');
    
    // Close all WhatsApp instances
    for (const [sessionId, instance] of whatsappInstances) {
        try {
            await instance.destroy();
            console.log(`✅ Session ${sessionId} destroyed`);
        } catch (error) {
            console.error(`❌ Error destroying session ${sessionId}:`, error);
        }
    }
    
    server.close(() => {
        console.log('🏁 Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('🔄 SIGINT received, shutting down gracefully...');
    
    // Close all WhatsApp instances
    for (const [sessionId, instance] of whatsappInstances) {
        try {
            await instance.destroy();
            console.log(`✅ Session ${sessionId} destroyed`);
        } catch (error) {
            console.error(`❌ Error destroying session ${sessionId}:`, error);
        }
    }
    
    server.close(() => {
        console.log('🏁 Server closed');
        process.exit(0);
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err.stack);
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 WhatsApp Auto Bot Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📱 Ready to accept WhatsApp connections!`);
});
