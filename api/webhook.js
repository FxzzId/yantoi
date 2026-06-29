const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data.json');
const QRISPY_WEBHOOK_SECRET = process.env.QRISPY_WEBHOOK_SECRET || 'whsec_AVu3fFLUBVMLjo6OdCWq7I3qdQ2CJ6e2';
const QRISPY_TOKEN = process.env.QRISPY_TOKEN || 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = process.env.QRISPY_API_URL || 'https://api.qrispy.id';

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const defaultData = {
        products: [
          { id: 1, name: 'Contoh Produk', description: 'Ini produk contoh', price: 10000, stock: 10, itemType: 'text', itemContent: 'Kode produk contoh', bonusType: 'none', bonusContent: '', createdAt: new Date().toISOString() }
        ],
        orders: [],
        users: [],
        deposits: [],
        withdrawals: [],
        referralClicks: {},
        maintenance: false,
        webhookLogs: []
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const raw = fs.readFileSync(DATA_FILE);
    return JSON.parse(raw);
  } catch (e) {
    return { products: [], orders: [], users: [], deposits: [], withdrawals: [], referralClicks: {}, maintenance: false, webhookLogs: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateOrderCode() {
  return 'YAN' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateReferralCode(name) {
  return name.substring(0, 3).toUpperCase() + Date.now().toString(36).substring(0, 6).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function verifySignature(payload, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

async function fetchQrispy(endpoint, options = {}) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(QRISPY_API_URL + endpoint, {
    ...options,
    headers: {
      'X-API-Token': QRISPY_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Qrispy-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.url.split('?')[0];
  const method = req.method;
  const body = req.body || {};
  const query = req.query || {};

  try {

  // ========== WEBHOOK GET (TEST) ==========
  if (url === '/api/webhook' && method === 'GET') {
    return res.json({ status: 'ok', message: 'Webhook Qrispy aktif!' });
  }

  // ========== WEBHOOK POST (payment.received) ==========
  if (url === '/api/webhook' && method === 'POST') {
    try {
      const rawPayload = JSON.stringify(req.body);
      const signature = req.headers['x-qrispy-signature'] || '';
      if (!verifySignature(rawPayload, signature, QRISPY_WEBHOOK_SECRET)) {
        return res.status(401).json({ error: 'Signature tidak valid' });
      }
      const { event, data } = req.body;
      if (event === 'payment.received') {
        const { qris_id, amount, received_amount, paid_at } = data;
        const db = readData();
        let order = db.orders.find(o => o.qrisId === qris_id);
        if (order) {
          order.status = 'paid';
          order.paidAt = paid_at || new Date().toISOString();
          order.receivedAmount = received_amount || amount;
          writeData(db);
        } else {
          let deposit = db.deposits.find(d => d.qrisId === qris_id);
          if (deposit) {
            deposit.status = 'paid';
            deposit.paidAt = paid_at || new Date().toISOString();
            const user = db.users.find(u => u.name === deposit.userName);
            if (user) user.discountBalance = (user.discountBalance || 0) + (deposit.amount || amount);
            writeData(db);
          }
        }
        db.webhookLogs = db.webhookLogs || [];
        db.webhookLogs.push({ event, qris_id, amount, received_amount, paid_at, processedAt: new Date().toISOString()
