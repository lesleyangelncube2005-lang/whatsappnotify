require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
// Country code + number, digits only. Example: 919876543210
const TARGET_NUMBER = process.env.TARGET_NUMBER;
// Simple shared secret so strangers can't use your /send endpoint
const API_TOKEN = process.env.API_TOKEN || '';

if (!TARGET_NUMBER) {
  console.error('Set TARGET_NUMBER in .env (e.g. 919876543210)');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

let status = 'starting'; // starting | qr | ready | disconnected
let lastQR = null;

const client = new Client({
  authStrategy: new LocalAuth(), // keeps the session so you scan only once
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', async (qr) => {
  status = 'qr';
  lastQR = await QRCode.toDataURL(qr);
  io.emit('qr', lastQR);
  io.emit('status', status);
});

client.on('ready', () => {
  status = 'ready';
  lastQR = null;
  console.log('WhatsApp client ready');
  io.emit('status', status);
});

client.on('disconnected', (reason) => {
  status = 'disconnected';
  console.log('Disconnected:', reason);
  io.emit('status', status);
  client.initialize(); // generates a fresh QR
});

// Incoming messages -> push to the website + optional auto-reply
client.on('message', async (msg) => {
  io.emit('incoming', {
    from: msg.from,
    body: msg.body,
    time: new Date(msg.timestamp * 1000).toISOString(),
  });

  if (msg.body.trim().toLowerCase() === 'hi') {
    await msg.reply('Hello! This is an automated reply.');
  }
});

// Website -> send message to the fixed number
app.post('/send', async (req, res) => {
  if (API_TOKEN && req.get('x-api-token') !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is empty' });
  }
  if (status !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected. Scan the QR first.' });
  }
  try {
    const id = await client.getNumberId(TARGET_NUMBER);
    if (!id) return res.status(404).json({ error: 'Number is not on WhatsApp' });
    await client.sendMessage(id._serialized, message);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send' });
  }
});

io.on('connection', (socket) => {
  socket.emit('status', status);
  if (lastQR) socket.emit('qr', lastQR);
});

client.initialize();
server.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
