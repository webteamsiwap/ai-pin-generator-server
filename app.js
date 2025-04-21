require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(cors());

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 25 // limit each IP to 25 requests per windowMs
});

// Apply rate limiting to all routes
app.use(limiter);

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

    // Generate image using DALL-E
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      response_format: "url"
    });

    res.json({
      success: true,
      imageUrl: response.data[0].url
    });
  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).json({
      error: 'Failed to generate image',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 