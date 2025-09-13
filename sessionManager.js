const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class SessionManager {
    constructor() {
        this.sessionsDir = path.join(__dirname, 'sessions');
        this.sessionFile = path.join(__dirname, 'active-sessions.json');
        this.activeSessions = new Map();
        this.initialize();
    }

    async initialize() {
        try {
            // Create sessions directory if it doesn't exist
            await this.ensureSessionsDirectory();
            
            // Load existing active sessions
            await this.loadActiveSessions();
            
            console.log('✅ SessionManager initialized successfully');
        } catch (error) {
            console.error('❌ Error initializing SessionManager:', error);
        }
    }

    async ensureSessionsDirectory() {
        try {
            await fs.access(this.sessionsDir);
        } catch (error) {
            // Directory doesn't exist, create it
            await fs.mkdir(this.sessionsDir, { recursive: true });
            console.log(`📁 Created sessions directory: ${this.sessionsDir}`);
        }
    }

    async loadActiveSessions() {
        try {
            await fs.access(this.sessionFile);
            const data = await fs.readFile(this.sessionFile, 'utf8');
            const sessions = JSON.parse(data);
            
            sessions.forEach(session => {
                this.activeSessions.set(session.sessionId, {
                    ...session,
                    createdAt: new Date(session.createdAt),
                    lastActivity: new Date(session.lastActivity)
                });
            });
            
            console.log(`📋 Loaded ${this.activeSessions.size} active sessions`);
        } catch (error) {
            // File doesn't exist or is corrupted, start fresh
            console.log('📋 No existing sessions found, starting fresh');
        }
    }

    async saveActiveSessions() {
        try {
            const sessions = Array.from(this.activeSessions.values()).map(session => ({
                ...session,
                createdAt: session.createdAt.toISOString(),
                lastActivity: session.lastActivity.toISOString()
            }));
            
            await fs.writeFile(this.sessionFile, JSON.stringify(sessions, null, 2));
        } catch (error) {
            console.error('❌ Error saving active sessions:', error);
        }
    }

    generateSessionId() {
        const timestamp = Date.now();
        const randomBytes = crypto.randomBytes(8).toString('hex');
        const sessionId = `wa_${timestamp}_${randomBytes}`;
        
        const sessionInfo = {
            sessionId,
            createdAt: new Date(),
            lastActivity: new Date(),
            status: 'created',
            messageCount: 0,
            isActive: true
        };

        this.activeSessions.set(sessionId, sessionInfo);
        this.saveActiveSessions();
        
        console.log(`🆔 Generated new session ID: ${sessionId}`);
        return sessionId;
    }

    async createSession(sessionId, metadata = {}) {
        try {
            const sessionInfo = this.activeSessions.get(sessionId);
            if (!sessionInfo) {
                throw new Error(`Session ${sessionId} not found`);
            }

            // Update session info
            sessionInfo.status = 'initializing';
            sessionInfo.metadata = metadata;
            sessionInfo.lastActivity = new Date();

            this.activeSessions.set(sessionId, sessionInfo);
            await this.saveActiveSessions();

            console.log(`📦 Session created: ${sessionId}`);
            return sessionInfo;
            
        } catch (error) {
            console.error(`❌ Error creating session ${sessionId}:`, error);
            throw error;
        }
    }

    async updateSessionStatus(sessionId, status, additionalData = {}) {
        try {
            const sessionInfo = this.activeSessions.get(sessionId);
            if (!sessionInfo) {
                console.warn(`⚠️  Session ${sessionId} not found for status update`);
                return;
            }

            sessionInfo.status = status;
            sessionInfo.lastActivity = new Date();
            
            // Merge additional data
            Object.assign(sessionInfo, additionalData);

            this.activeSessions.set(sessionId, sessionInfo);
            await this.saveActiveSessions();

            console.log(`📊 Session ${sessionId} status updated: ${status}`);
            
        } catch (error) {
            console.error(`❌ Error updating session ${sessionId} status:`, error);
        }
    }

    async incrementMessageCount(sessionId) {
        try {
            const sessionInfo = this.activeSessions.get(sessionId);
            if (sessionInfo) {
                sessionInfo.messageCount = (sessionInfo.messageCount || 0) + 1;
                sessionInfo.lastActivity = new Date();
                this.activeSessions.set(sessionId, sessionInfo);
                await this.saveActiveSessions();
            }
        } catch (error) {
            console.error(`❌ Error incrementing message count for ${sessionId}:`, error);
        }
    }

    getSession(sessionId) {
        return this.activeSessions.get(sessionId);
    }

    getAllSessions() {
        return Array.from(this.activeSessions.values());
    }

    getActiveSessionsCount() {
        return Array.from(this.activeSessions.values())
            .filter(session => session.isActive && session.status !== 'destroyed').length;
    }

    async removeSession(sessionId) {
        try {
            const sessionInfo = this.activeSessions.get(sessionId);
            if (!sessionInfo) {
                console.warn(`⚠️  Session ${sessionId} not found for removal`);
                return;
            }

            // Mark as inactive instead of deleting immediately
            sessionInfo.isActive = false;
            sessionInfo.status = 'destroyed';
            sessionInfo.lastActivity = new Date();
            
            this.activeSessions.set(sessionId, sessionInfo);
            await this.saveActiveSessions();

            console.log(`🗑️  Session ${sessionId} marked as destroyed`);
            
        } catch (error) {
            console.error(`❌ Error removing session ${sessionId}:`, error);
        }
    }

    async cleanupOldSessions(maxAgeHours = 24) {
        try {
            const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
            let cleanedCount = 0;

            for (const [sessionId, sessionInfo] of this.activeSessions) {
                if (sessionInfo.lastActivity < cutoffTime && !sessionInfo.isActive) {
                    // Remove from memory
                    this.activeSessions.delete(sessionId);
                    
                    // Remove session directory
                    const sessionDir = path.join(this.sessionsDir, sessionId);
                    try {
                        await fs.rmdir(sessionDir, { recursive: true });
                        console.log(`🧹 Cleaned up session directory: ${sessionId}`);
                    } catch (error) {
                        console.warn(`⚠️  Could not remove session directory ${sessionId}:`, error.message);
                    }
                    
                    cleanedCount++;
                }
            }

            if (cleanedCount > 0) {
                await this.saveActiveSessions();
                console.log(`🧹 Cleaned up ${cleanedCount} old sessions`);
            }

            return cleanedCount;
            
        } catch (error) {
            console.error('❌ Error during session cleanup:', error);
            return 0;
        }
    }

    async getSessionStats() {
        const sessions = Array.from(this.activeSessions.values());
        
        const stats = {
            total: sessions.length,
            active: sessions.filter(s => s.isActive).length,
            ready: sessions.filter(s => s.status === 'ready').length,
            connecting: sessions.filter(s => s.status === 'connecting' || s.status === 'qr_generated').length,
            error: sessions.filter(s => s.status === 'error' || s.status === 'auth_failed').length,
            destroyed: sessions.filter(s => s.status === 'destroyed').length,
            totalMessages: sessions.reduce((sum, s) => sum + (s.messageCount || 0), 0)
        };

        return stats;
    }

    async exportSessionsData() {
        try {
            const sessions = Array.from(this.activeSessions.values());
            const exportData = {
                exportDate: new Date().toISOString(),
                totalSessions: sessions.length,
                sessions: sessions
            };

            return exportData;
            
        } catch (error) {
            console.error('❌ Error exporting sessions data:', error);
            throw error;
        }
    }

    // Periodic cleanup task
    startCleanupTask(intervalHours = 6, maxAgeHours = 24) {
        setInterval(async () => {
            console.log('🔄 Starting periodic session cleanup...');
            const cleaned = await this.cleanupOldSessions(maxAgeHours);
            console.log(`🔄 Periodic cleanup completed. Cleaned: ${cleaned} sessions`);
        }, intervalHours * 60 * 60 * 1000);

        console.log(`⏰ Session cleanup task started (every ${intervalHours}h, max age: ${maxAgeHours}h)`);
    }

    // Validate session ID format
    isValidSessionId(sessionId) {
        const pattern = /^wa_\d+_[a-f0-9]{16}$/;
        return pattern.test(sessionId);
    }

    // Get session directory path
    getSessionDirectory(sessionId) {
        return path.join(this.sessionsDir, sessionId);
    }

    // Check if session directory exists
    async sessionDirectoryExists(sessionId) {
        try {
            const sessionDir = this.getSessionDirectory(sessionId);
            await fs.access(sessionDir);
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = SessionManager;
