const path = require('path');
const rootDir = path.resolve(__dirname, '..');
console.log('Project root directory:', rootDir);
console.log('Looking for .env file in:', path.join(rootDir, '.env'));

require('dotenv').config({ path: path.join(rootDir, '.env') });
const express = require('express');
const { generateAsync } = require('stability-client');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const crypto = require('crypto');

// Add fetch for Node.js versions that don't have it built-in
if (!global.fetch) {
  global.fetch = require('node-fetch');
}

// Debug: Check if API key is loaded
console.log('Environment variables loaded:', {
  STABILITY_API_KEY: process.env.STABILITY_API_KEY ? 'Key exists' : 'Key is undefined',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SHOPIFY_SHOP_URL: process.env.SHOPIFY_SHOP_URL ? 'Exists' : 'Undefined',
  SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN ? 'Exists' : 'Undefined'
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Rate limiting configuration
const RATE_LIMITS = {
  daily: 500,    // 500 requests per day per IP
  hourly: 50,    // 50 requests per hour per IP  
  burst: 20      // 20 requests per minute per IP
};

// Rate limiting - Production optimized
const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: RATE_LIMITS.daily,
  message: {
    error: 'Daily limit exceeded',
    message: 'You have reached your daily generation limit. Please try again tomorrow.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Burst protection - prevent spam
const burstLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMITS.burst,
  message: {
    error: 'Too many requests',
    message: 'You are generating too quickly. Please wait a moment and try again.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Per-hour limiter for better distribution
const hourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: RATE_LIMITS.hourly,
  message: {
    error: 'Hourly limit exceeded',
    message: 'You have reached your hourly generation limit. Please wait a bit.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Log the rate limiter configuration
console.log('🚀 Rate Limiter Configuration:');
console.log(`   - Daily limit: ${RATE_LIMITS.daily} requests per IP per day`);
console.log(`   - Hourly limit: ${RATE_LIMITS.hourly} requests per IP per hour`);
console.log(`   - Burst limit: ${RATE_LIMITS.burst} requests per IP per minute`);

// Apply rate limiting to all routes (can be disabled with DISABLE_RATE_LIMIT=true)
if (process.env.DISABLE_RATE_LIMIT !== 'true') {
  app.use(dailyLimiter);
  app.use(hourlyLimiter);
  app.use(burstLimiter);
  console.log('✅ Rate limiting enabled');
} else {
  console.log('⚠️  Rate limiting disabled (DISABLE_RATE_LIMIT=true)');
}

// Simple middleware to log remaining requests
app.use((req, res, next) => {
  // Get rate limit info from response headers
  const remaining = res.getHeader('X-RateLimit-Remaining');
  const limit = res.getHeader('X-RateLimit-Limit');
  
  if (remaining !== undefined && limit !== undefined) {
    const clientIP = req.ip || req.connection.remoteAddress;
    console.log(`📊 Rate Limit for ${clientIP}: ${remaining}/${limit} remaining`);
  }
  
  next();
});

// Content moderation function
function moderateContent(prompt) {
  const blacklist = [
    'celebrity', 'celebrities', 'famous', 'star', 
    'trademark', 'logo', 'brand', 
    'disney', 'marvel', 'pokemon',
    'political', 'politician', 'president'
  ];

  const promptLower = prompt.toLowerCase();
  const matches = blacklist.filter(word => promptLower.includes(word));
  
  if (matches.length > 0) {
    return {
      allowed: false,
      reason: `Prompt contains restricted words: ${matches.join(', ')}`
    };
  }

  return { allowed: true };
}

// Test endpoint using direct API call
app.get('/test-stability', async (req, res) => {
  try {
    const response = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        text_prompts: [{ text: "A simple blue circle" }],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        steps: 30,
        samples: 4
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'API request failed');
    }

    const result = await response.json();
    console.log('API Response:', {
      status: response.status,
      hasImages: !!result.artifacts,
      numberOfImages: result.artifacts ? result.artifacts.length : 0
    });

    res.json({ 
      success: true, 
      message: 'API connection successful',
      imageGenerated: !!result.artifacts
    });
  } catch (error) {
    console.error('Stability AI Test Error:', error);
    res.status(500).json({
      error: 'API test failed',
      message: error.message
    });
  }
});

// Generate image endpoint
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;

    // Check content moderation
    const moderation = moderateContent(prompt);
    if (!moderation.allowed) {
      return res.status(400).json({
        error: 'Content not allowed',
        message: moderation.reason
      });
    }

    // Generate image using Stability AI direct API
    const response = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt }],
        cfg_scale: 7,
        height: 1024,
        width: 1024,
        steps: 30,
        samples: 1 // Changed from 1 to 4 to generate four images
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to generate image');
    }

    const result = await response.json();
    if (!result.artifacts || result.artifacts.length === 0) {
      throw new Error('No image generated');
    }

    // Return all four images
    const images = result.artifacts.map(artifact => ({
      imageUrl: `data:image/png;base64,${artifact.base64}`
    }));

    res.json({
      success: true,
      images: images
    });
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({
      error: 'Failed to generate image',
      message: error.message
    });
  }
});

// Save image endpoint
app.post('/save-image', async (req, res) => {
  try {
    const { imageData } = req.body;
    
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }
    
    // Extract base64 data - handle both full data URIs or just base64 content
    let base64Data = imageData;
    if (imageData.includes('base64,')) {
      base64Data = imageData.split('base64,')[1];
    }
    
    // Generate a unique filename
    const filename = `${crypto.randomUUID()}.png`;
    const filepath = path.join(uploadsDir, filename);
    
    // Save the file
    fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
    
    // Generate public URL for the image
    const host = process.env.APP_URL || `http://localhost:${PORT}`;
    const imageUrl = `${host}/uploads/${filename}`;
    
    res.json({
      success: true,
      imageUrl
    });
  } catch (error) {
    console.error('Error saving image:', error);
    res.status(500).json({
      error: 'Failed to save image',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Rate limit status endpoint
app.get('/rate-limit-status', (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Get current rate limit info from headers
  const dailyRemaining = res.getHeader('X-RateLimit-Remaining');
  const dailyLimit = res.getHeader('X-RateLimit-Limit');
  const reset = res.getHeader('X-RateLimit-Reset');
  
  console.log(`🔍 Rate Limit Status Check for ${clientIP}:`);
  console.log(`   - Daily limit: ${RATE_LIMITS.daily} requests`);
  console.log(`   - Hourly limit: ${RATE_LIMITS.hourly} requests`);
  console.log(`   - Burst limit: ${RATE_LIMITS.burst} requests`);
  console.log(`   - Current remaining: ${dailyRemaining || 'unknown'}`);
  console.log(`   - Reset time: ${reset ? new Date(reset * 1000).toLocaleString() : 'unknown'}`);
  
  res.json({
    ip: clientIP,
    limits: {
      daily: {
        max: RATE_LIMITS.daily,
        remaining: dailyRemaining || 'unknown',
        windowMs: dailyLimiter.windowMs
      },
      hourly: {
        max: RATE_LIMITS.hourly,
        windowMs: hourlyLimiter.windowMs
      },
      burst: {
        max: RATE_LIMITS.burst,
        windowMs: burstLimiter.windowMs
      }
    },
    resetTime: reset ? new Date(reset * 1000).toISOString() : 'unknown'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 