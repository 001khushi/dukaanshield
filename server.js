const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const STORES_FILE = path.join(__dirname, 'stores.json');
if (!fs.existsSync(STORES_FILE)) {
  fs.writeFileSync(STORES_FILE, JSON.stringify({}));
}
const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GODADDY_EMAIL || 'orders@dukaanshield.com',
        pass: process.env.GODADDY_PASSWORD || 'KSdukaan001@',
      },
    });
// Detect real image media type from file bytes (fixes renamed .webp/.png/.jpg files)
function detectMediaType(buffer, fallbackMime) {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return 'image/gif';
  }
  return fallbackMime;
}

// 1. AI Agent Endpoint: Reads Handwritten Menu + Applies Privacy Shield + Checks Domain
app.post('/api/launch-store', upload.single('menuImage'), async (req, res) => {
  try {
    const { businessName, privacyShield } = req.body;
    const imageFile = req.file;

    let imageMessagePart = null;
    if (imageFile) {
      const base64Image = imageFile.buffer.toString('base64');
      const actualMediaType = detectMediaType(imageFile.buffer, imageFile.mimetype);
      imageMessagePart = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: actualMediaType,
          data: base64Image,
        },
      };
    }

    const isShieldOn = privacyShield === 'true';

    const promptText = `
You are DukaanShield, an expert AI business launch agent for Indian micro-entrepreneurs.
Business Name/Idea: "${businessName}"
Privacy & Safety Shield Active: ${isShieldOn ? 'YES (Scrub any personal phone numbers and home/flat addresses from public display, replace with masked GoDaddy domain mailbox, and generate safe pickup-only hours & trust badges)' : 'NO'}

Task:
1. If an image of a handwritten notebook or menu is provided, read all items, weights/quantities, and prices accurately (handle Hindi/Hinglish/English).
2. Clean up spelling and structure them as a neat catalog JSON array.
3. Generate a catchy tagline, 3 digital storefront features, trust badges, and safe operating guidelines.
4. Suggest 2 available GoDaddy domain names ending in .in and .shop.

Return ONLY valid JSON (no markdown fences, no extra commentary) with exact keys:
{
  "business": "Clean Business Name",
  "privacyShieldActive": ${isShieldOn},
  "privacyNote": "Brief explanation of what personal info was scrubbed/protected (or standard contact mode if shield is off)",
  "tagline": "Catchy tagline",
  "catalog": [
    { "item": "Product Name", "quantity": "250g or Standard", "price": "₹180", "category": "Category" }
  ],
  "trustBadges": ["Badge 1", "Badge 2", "Badge 3"],
  "policies": {
    "pickupHours": {
      "days": "Tue - Sun",
      "hours": "11:00 AM - 6:00 PM",
      "note": "Safe pickup/delivery policy note"
    }
  },
  "suggestedDomains": ["brandname.in", "brandname.shop"]
}
    `;

    const contentBlocks = [];
    if (imageMessagePart) contentBlocks.push(imageMessagePart);
    contentBlocks.push({ type: 'text', text: promptText });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: contentBlocks }],
    });

    const aiResponseText = message.content[0].text;

    let parsedData;
    try {
      const cleaned = aiResponseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsedData = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: aiResponseText };
    } catch (e) {
      parsedData = { raw: aiResponseText };
    }

    res.json({ success: true, data: parsedData });
  } catch (error) {
    console.error('AI Agent Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Publish Storefront & Return Shareable Slug
app.post('/api/publish-store', (req, res) => {
  try {
    const { storeData } = req.body;
    if (!storeData) {
      return res.status(400).json({ success: false, error: 'No store data provided' });
    }

    const rawName = storeData.business || 'my-dukaan';
    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') + '-' + Math.floor(100 + Math.random() * 900);

    const stores = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
    stores[slug] = {
      ...storeData,
      publishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STORES_FILE, JSON.stringify(stores, null, 2));

    res.json({ success: true, slug, publicUrl: `/shop/${slug}` });
  } catch (error) {
    console.error('Publish Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Fetch Published Store Data for Customer View
app.get('/api/store/:slug', (req, res) => {
  try {
    const stores = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
    const store = stores[req.params.slug];
    if (!store) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }
    res.json({ success: true, data: store });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Serve Clean Public Storefront Page at /shop/:slug
app.get('/shop/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 5. Mandatory Contact Form / Order Endpoint (Sends via GoDaddy SMTP)
app.post('/api/send-order', async (req, res) => {
  const { customerName, customerPhone, orderDetails, storeName, targetEmail } = req.body;

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtpout.secureserver.net',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GODADDY_EMAIL || 'hello@yourdomain.com',
        pass: process.env.GODADDY_PASSWORD || 'your_email_password',
      },
    });

    const mailOptions = {
      from: `"DukaanShield Order Bot" <${process.env.GODADDY_EMAIL || 'hello@yourdomain.com'}>`,
      to: targetEmail || process.env.GODADDY_EMAIL || 'hello@yourdomain.com',
      subject: `🛍️ New Safe Order Inquiry for ${storeName || 'DukaanShield Store'} from ${customerName}`,
      html: `
        <h3>New Customer Inquiry via DukaanShield</h3>
        <p><strong>Store:</strong> ${storeName || 'DukaanShield Storefront'}</p>
        <p><strong>Customer Name:</strong> ${customerName}</p>
        <p><strong>Contact Info:</strong> ${customerPhone}</p>
        <p><strong>Order Details:</strong> ${orderDetails}</p>
        <hr>
        <p style="color: #666; font-size: 12px;">Secured by DukaanShield & GoDaddy Domain Mailbox</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'Order sent securely to the store owner’s GoDaddy mailbox!' });
  } catch (error) {
    console.error('SMTP Email Error:', error);
    // If real credentials are set in .env, report the actual SMTP error so we can debug it
    if (process.env.GODADDY_EMAIL && process.env.GODADDY_EMAIL !== 'hello@yourdomain.com') {
      return res.status(500).json({ success: false, message: 'SMTP Delivery Failed: ' + error.message });
    }
    res.json({ success: true, message: 'Order received and logged (GoDaddy SMTP dispatch simulated locally)!' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DukaanShield running locally on http://localhost:${PORT}`);
});