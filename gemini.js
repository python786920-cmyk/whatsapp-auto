const { GoogleGenerativeAI } = require('@google/generative-ai');
const NodeCache = require('node-cache');

class GeminiAI {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;
        this.genAI = null;
        this.model = null;
        this.cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour
        
        if (!this.apiKey) {
            console.error('❌ GEMINI_API_KEY not found in environment variables');
            throw new Error('Gemini API key is required');
        }
        
        this.initialize();
    }

    initialize() {
        try {
            this.genAI = new GoogleGenerativeAI(this.apiKey);
            this.model = this.genAI.getGenerativeModel({ 
                model: "gemini-pro",
                generationConfig: {
                    temperature: 0.8,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 200,
                }
            });
            
            console.log('✅ Gemini AI initialized successfully');
        } catch (error) {
            console.error('❌ Error initializing Gemini AI:', error);
            throw error;
        }
    }

    async generateResponse(userMessage, contactName = 'Friend', chatHistory = []) {
        try {
            // Check cache first
            const cacheKey = `response_${this.hashMessage(userMessage)}`;
            const cachedResponse = this.cache.get(cacheKey);
            
            if (cachedResponse) {
                console.log('📦 Using cached response');
                return this.addPersonalTouch(cachedResponse, contactName);
            }

            // Detect language from user message
            const detectedLanguage = this.detectLanguage(userMessage);
            
            // Build conversation context
            const conversationContext = this.buildConversationContext(chatHistory);
            
            // Create system prompt based on detected language
            const systemPrompt = this.createSystemPrompt(detectedLanguage, contactName, conversationContext);
            
            // Generate response
            const prompt = `${systemPrompt}\n\nUser message: "${userMessage}"\n\nReply naturally as a close friend:`;
            
            const result = await this.model.generateContent(prompt);
            const response = result.response;
            let generatedText = response.text();

            // Clean and format response
            generatedText = this.cleanResponse(generatedText);
            
            // Add human-like variations
            generatedText = this.addHumanVariations(generatedText, detectedLanguage);
            
            // Cache the response
            this.cache.set(cacheKey, generatedText);
            
            console.log(`🤖 Generated AI response: ${generatedText.substring(0, 50)}...`);
            return generatedText;
            
        } catch (error) {
            console.error('❌ Error generating Gemini response:', error);
            return this.getFallbackResponse(userMessage);
        }
    }

    detectLanguage(message) {
        const hindiWords = ['hai', 'hain', 'kya', 'kaise', 'kahan', 'kab', 'kaun', 'main', 'mein', 'tum', 'aap', 'yeh', 'woh', 'aur', 'ki', 'ke', 'ka', 'se', 'mera', 'tera', 'uska', 'bhai', 'yaar', 'dost'];
        const englishWords = ['the', 'and', 'you', 'are', 'what', 'how', 'where', 'when', 'who', 'this', 'that', 'with', 'have', 'will', 'can', 'should', 'would'];
        
        const lowerMessage = message.toLowerCase();
        const hindiCount = hindiWords.filter(word => lowerMessage.includes(word)).length;
        const englishCount = englishWords.filter(word => lowerMessage.includes(word)).length;
        
        // Check for Hinglish patterns
        const hinglishPatterns = /\b(bro|yaar|bhai|dude|man|kya|hai|hain|tum|main|mein)\b/i;
        const hasHinglishPattern = hinglishPatterns.test(message);
        
        if (hindiCount > englishCount || hasHinglishPattern) {
            return 'hinglish';
        } else if (englishCount > 0) {
            return 'english';
        } else {
            return 'hinglish'; // Default to hinglish
        }
    }

    createSystemPrompt(language, contactName, conversationContext) {
        const basePersonality = `You are chatting with your close friend ${contactName}. You are a fun, friendly, and helpful person who speaks naturally like a real human friend.`;
        
        let languageInstructions = '';
        let responseStyle = '';
        
        switch (language) {
            case 'hinglish':
                languageInstructions = 'Reply in natural Hinglish (mix of Hindi and English) like young Indians chat. Use words like "yaar", "bhai", "kya baat hai", "achha", "thik hai", etc.';
                responseStyle = 'Keep it casual, short, and friendly. Use emojis occasionally. Sound like a close desi friend.';
                break;
                
            case 'english':
                languageInstructions = 'Reply in casual English like a close friend would. Use natural, conversational English.';
                responseStyle = 'Keep it friendly, supportive, and natural. Use casual language and be relatable.';
                break;
                
            default:
                languageInstructions = 'Reply in the same language/style as the user. Match their communication style.';
                responseStyle = 'Be natural and friendly, adapting to their way of speaking.';
        }

        let contextPrompt = '';
        if (conversationContext) {
            contextPrompt = `\nPrevious conversation context:\n${conversationContext}\n`;
        }

        return `${basePersonality}

${languageInstructions}

${responseStyle}

Important rules:
- Keep responses under 50 words
- Be helpful and supportive
- Show genuine interest in their problems
- Give practical advice when asked
- Use humor when appropriate
- Remember you're talking to a friend, not a customer
- Don't be overly formal or robotic
- If you don't know something, admit it honestly
- Avoid repetitive responses

${contextPrompt}`;
    }

    buildConversationContext(chatHistory) {
        if (!chatHistory || chatHistory.length === 0) return '';
        
        // Get last 3 exchanges
        const recentHistory = chatHistory.slice(-6);
        let context = '';
        
        recentHistory.forEach(entry => {
            const sender = entry.isBot ? 'You' : 'Friend';
            context += `${sender}: ${entry.message}\n`;
        });
        
        return context;
    }

    cleanResponse(response) {
        // Remove common AI-generated prefixes/suffixes
        response = response.replace(/^(Sure|Okay|Alright|Well|So|Here|Response:|Reply:)\s*/i, '');
        response = response.replace(/\s*(Let me know|Hope this helps|Feel free to ask|Any other questions).*$/i, '');
        
        // Remove excessive punctuation
        response = response.replace(/[!]{2,}/g, '!');
        response = response.replace(/[?]{2,}/g, '?');
        response = response.replace(/[.]{2,}/g, '...');
        
        // Trim whitespace
        response = response.trim();
        
        return response;
    }

    addHumanVariations(response, language) {
        // Add occasional typos and casual variations for natural feel
        const variations = {
            'hinglish': {
                'okay': ['ok', 'okk', 'theek hai', 'achha'],
                'good': ['achha', 'badhiya', 'nice'],
                'yes': ['haan', 'han', 'yeah', 'ha'],
                'no': ['nahi', 'nah', 'naa'],
                'what': ['kya', 'kya baat', 'what'],
                'how': ['kaise', 'kese', 'how'],
                'friend': ['yaar', 'bro', 'dost', 'bhai']
            },
            'english': {
                'okay': ['ok', 'alright', 'cool'],
                'good': ['nice', 'great', 'awesome'],
                'yes': ['yeah', 'yep', 'sure'],
                'no': ['nah', 'nope'],
                'friend': ['buddy', 'dude', 'bro']
            }
        };

        // Randomly apply variations (20% chance)
        if (Math.random() < 0.2 && variations[language]) {
            const languageVariations = variations[language];
            Object.keys(languageVariations).forEach(word => {
                const regex = new RegExp(`\\b${word}\\b`, 'gi');
                if (regex.test(response)) {
                    const alternatives = languageVariations[word];
                    const randomAlt = alternatives[Math.floor(Math.random() * alternatives.length)];
                    response = response.replace(regex, randomAlt);
                }
            });
        }

        return response;
    }

    addPersonalTouch(response, contactName) {
        // Occasionally add personal address (10% chance)
        if (Math.random() < 0.1 && contactName !== 'Friend') {
            const personalGreetings = ['yaar', 'bro', 'dude', contactName];
            const greeting = personalGreetings[Math.floor(Math.random() * personalGreetings.length)];
            response = `${greeting}, ${response}`;
        }
        
        return response;
    }

    getFallbackResponse(userMessage) {
        const fallbackResponses = {
            greeting: [
                "Hey! Kya haal hai? 😊",
                "Arre yaar, kaisa chal raha hai?",
                "Hello bro! Sab badiya?",
                "Hi! What's up? 👋"
            ],
            question: [
                "Hmm, interesting question yaar!",
                "Good question! Let me think...",
                "Arre, ye toh sochna padega 🤔",
                "Wah bhai, deep question hai!"
            ],
            thanks: [
                "Arre yaar, mention not! 😄",
                "Koi baat nahi bro!",
                "Happy to help! 👍",
                "Always welcome dude!"
            ],
            default: [
                "Haan bhai, main sun raha hun! 👂",
                "Tell me more yaar!",
                "Interesting! Aur bata...",
                "I'm listening! Go on... 😊"
            ]
        };

        // Detect message type
        const message = userMessage.toLowerCase();
        let responseType = 'default';
        
        if (message.includes('hello') || message.includes('hi') || message.includes('hey') || message.includes('namaste')) {
            responseType = 'greeting';
        } else if (message.includes('?') || message.includes('how') || message.includes('what') || message.includes('kya') || message.includes('kaise')) {
            responseType = 'question';
        } else if (message.includes('thanks') || message.includes('thank') || message.includes('shukriya') || message.includes('dhanyawad')) {
            responseType = 'thanks';
        }
        
        const responses = fallbackResponses[responseType];
        return responses[Math.floor(Math.random() * responses.length)];
    }

    hashMessage(message) {
        // Simple hash function for caching
        let hash = 0;
        for (let i = 0; i < message.length; i++) {
            const char = message.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    // Method to clear cache if needed
    clearCache() {
        this.cache.flushAll();
        console.log('🗑️ Gemini AI cache cleared');
    }

    // Get cache statistics
    getCacheStats() {
        return {
            keys: this.cache.keys().length,
            hits: this.cache.getStats().hits,
            misses: this.cache.getStats().misses
        };
    }
}

module.exports = GeminiAI;
