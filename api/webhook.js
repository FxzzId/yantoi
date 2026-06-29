const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data.json');

// ========== ENV ==========
const QRISPY_WEBHOOK_SECRET = process.env.QRISPY_WEBHOOK_SECRET || 'whsec_AVu3fFLUBVMLjo6OdCWq7I3qdQ2CJ6e2';
const QRISPY_TOKEN = process.env.QRISPY_TOKEN || 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = process.env.QRISPY_API_URL || 'https://api.qrispy.id';

// ========== DATA HELPER ==========
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
        adminIP: null,
        maintenance: false,
        webhookLogs: []
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const raw = fs.readFileSync(DATA_FILE);
    return JSON.parse(raw);
  } catch (e) {
    return { products: [], orders: [], users: [], deposits: [], withdrawals: [], referralClicks: {}, adminIP: null, maintenance: false, webhookLogs: [] };
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

// ========== VERIFIKASI SIGNATURE ==========
function verifySignature(payload, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

// ========== FETCH QRISPY ==========
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

// ========== MAIN HANDLER ==========
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie, X-User-Name, X-Qrispy-Signature');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = req.url.split('?')[0];
  const method = req.method;
  const body = req.body || {};
  const query = req.query || {};

  try {

  // ============================================================
  // WEBHOOK GET (TEST)
  // ============================================================
  if (url === '/api/webhook' && method === 'GET') {
    return res.json({
      status: 'ok',
      message: 'Webhook Qrispy aktif!',
      config: {
        secret: QRISPY_WEBHOOK_SECRET.substring(0, 10) + '...',
        token: QRISPY_TOKEN.substring(0, 10) + '...',
        api_url: QRISPY_API_URL
      }
    });
  }

  // ============================================================
  // WEBHOOK POST (payment.received)
  // ============================================================
  if (url === '/api/webhook' && method === 'POST') {
    try {
      const rawPayload = JSON.stringify(req.body);
      const signature = req.headers['x-qrispy-signature'] || '';

      if (!verifySignature(rawPayload, signature, QRISPY_WEBHOOK_SECRET)) {
        console.log('❌ Signature tidak valid!');
        return res.status(401).json({ error: 'Signature tidak valid' });
      }

      console.log('✅ Signature valid!');

      const { event, data } = req.body;
      
      if (event === 'payment.received') {
        const { qris_id, amount, received_amount, payment_reference, paid_at, unique_id } = data;
        
        console.log(`💰 Pembayaran diterima: ${qris_id} - Rp ${amount}`);

        const db = readData();
        let order = db.orders.find(o => o.qrisId === qris_id);
        
        if (order) {
          order.status = 'paid';
          order.paidAt = paid_at || new Date().toISOString();
          order.receivedAmount = received_amount || amount;
          writeData(db);
          console.log(`✅ Order ${order.orderCode} berhasil dibayar!`);
        } else {
          let deposit = db.deposits.find(d => d.qrisId === qris_id);
          if (deposit) {
            deposit.status = 'paid';
            deposit.paidAt = paid_at || new Date().toISOString();
            deposit.receivedAmount = received_amount || amount;
            
            const user = db.users.find(u => u.name === deposit.userName);
            if (user) {
              user.discountBalance = (user.discountBalance || 0) + (deposit.amount || amount);
            }
            writeData(db);
            console.log(`✅ Deposit ${deposit.id} berhasil! Saldo ditambahkan ke ${deposit.userName}`);
          } else {
            console.log(`⚠️ QRIS ${qris_id} tidak ditemukan di database`);
          }
        }

        db.webhookLogs = db.webhookLogs || [];
        db.webhookLogs.push({
          event,
          qris_id,
          amount,
          received_amount,
          paid_at,
          processedAt: new Date().toISOString()
        });
        writeData(db);

        return res.json({ 
          success: true, 
          message: 'Webhook diproses',
          orderFound: !!order,
          depositFound: !!deposit
        });
      }

      console.log(`📨 Event lain: ${event}`);
      return res.json({ success: true, message: 'Event diterima: ' + event });

    } catch (error) {
      console.error('❌ Error webhook:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // ============================================================
  // PUBLIC STATS
  // ============================================================
  if (url === '/api/public-stats' && method === 'GET') {
    const data = readData();
    const orders = data.orders || [];
    const soldMap = {};
    orders.filter(o => o.status === 'paid').forEach(o => {
      soldMap[o.productId] = (soldMap[o.productId] || 0) + 1;
    });
    return res.json({
      success: true,
      soldMap,
      maintenance: data.maintenance || false,
      totalProducts: (data.products || []).length,
      totalOrders: orders.length
    });
  }

  // ============================================================
  // PRODUCTS
  // ============================================================
  if (url === '/api/products' && method === 'GET') {
    const data = readData();
    return res.json({ success: true, products: data.products || [] });
  }

  // ============================================================
  // CREATE ORDER
  // ============================================================
  if (url === '/api/create-order' && method === 'POST') {
    const { productId, customerName, qrisId, qrisImage, totalAmount, expiredAt } = body;
    const data = readData();
    const product = data.products.find(p => p.id === productId);
    if (!product) return res.json({ success: false, error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.json({ success: false, error: 'Stok habis' });

    const orderCode = generateOrderCode();
    const order = {
      id: Date.now(),
      orderCode,
      productId: product.id,
      productName: product.name,
      customerName: customerName || 'Guest',
      qrisId,
      qrisImage,
      totalAmount: totalAmount || product.price,
      price: product.price,
      itemType: product.itemType,
      productCode: product.itemContent,
      bonusContent: product.bonusContent || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiredAt: expiredAt || new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    product.stock -= 1;
    data.orders.push(order);
    writeData(data);

    return res.json({ success: true, orderCode });
  }

  // ============================================================
  // CREATE CART ORDER
  // ============================================================
  if (url === '/api/create-cart-order' && method === 'POST') {
    const { items, customerName, qrisId, qrisImage, totalAmount, expiredAt } = body;
    const data = readData();
    const productNames = [];
    let allStock = true;

    for (const item of items) {
      const product = data.products.find(p => p.id === item.productId);
      if (!product || product.stock < item.quantity) {
        allStock = false;
        break;
      }
      productNames.push(product.name);
    }

    if (!allStock) return res.json({ success: false, error: 'Stok produk tidak cukup' });

    // Kurangi stok
    for (const item of items) {
      const product = data.products.find(p => p.id === item.productId);
      if (product) product.stock -= item.quantity;
    }

    const orderCode = generateOrderCode();
    const order = {
      id: Date.now(),
      orderCode,
      productName: productNames.join(', '),
      customerName: customerName || 'Guest',
      qrisId,
      qrisImage,
      totalAmount: totalAmount || 0,
      price: totalAmount || 0,
      itemType: 'text',
      productCode: 'Multiple items',
      bonusContent: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiredAt: expiredAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      productId: null,
      cartItems: items
    };

    data.orders.push(order);
    writeData(data);

    return res.json({ success: true, orderCode });
  }

  // ============================================================
  // GET ORDER
  // ============================================================
  if (url.startsWith('/api/get-order/') && method === 'GET') {
    const orderCode = url.split('/').pop();
    const data = readData();
    const order = data.orders.find(o => o.orderCode === orderCode);
    if (!order) return res.json({ success: false, error: 'Order tidak ditemukan' });
    return res.json({
      success: true,
      ...order,
      productName: order.productName,
      productCode: order.productCode,
      itemType: order.itemType,
      bonusContent: order.bonusContent || '',
      totalAmount: order.totalAmount || order.price,
      status: order.status
    });
  }

  // ============================================================
  // CHECK PAYMENT
  // ============================================================
  if (url.startsWith('/api/check-payment/') && method === 'GET') {
    const orderCode = url.split('/').pop();
    const data = readData();
    const order = data.orders.find(o => o.orderCode === orderCode);
    if (!order) return res.json({ success: false, error: 'Order tidak ditemukan' });

    try {
      const qrisRes = await fetchQrispy('/api/payment/qris/' + order.qrisId + '/status');
      if (qrisRes.status === 'success' && qrisRes.data && qrisRes.data.status === 'paid') {
        order.status = 'paid';
        writeData(data);
        return res.json({ status: 'paid' });
      }
    } catch (e) {}

    if (new Date(order.expiredAt) < new Date()) {
      order.status = 'expired';
      writeData(data);
      return res.json({ status: 'expired' });
    }

    return res.json({ status: order.status || 'pending' });
  }

  // ============================================================
  // CANCEL ORDER
  // ============================================================
  if (url.startsWith('/api/cancel-order/') && method === 'POST') {
    const orderCode = url.split('/').pop();
    const data = readData();
    const order = data.orders.find(o => o.orderCode === orderCode);
    if (!order) return res.json({ success: false, error: 'Order tidak ditemukan' });
    if (order.status !== 'pending') return res.json({ success: false, error: 'Order sudah tidak bisa dibatalkan' });

    order.status = 'cancelled';
    const product = data.products.find(p => p.id === order.productId);
    if (product) product.stock += 1;
    writeData(data);

    return res.json({ success: true });
  }

  // ============================================================
  // REGISTER
  // ============================================================
  if (url === '/api/register' && method === 'POST') {
    const { name, birthDate, password } = body;
    const data = readData();
    if (data.users.find(u => u.name.toLowerCase() === name.toLowerCase())) {
      return res.json({ success: false, error: 'Nama sudah digunakan' });
    }
    const birth = new Date(birthDate);
    const age = new Date().getFullYear() - birth.getFullYear();
    if (age < 12) return res.json({ success: false, error: 'Minimal umur 12 tahun' });

    const user = {
      id: Date.now(),
      name,
      password,
      birthDate,
      referralCode: generateReferralCode(name),
      discountBalance: 0,
      referralClicks: 0,
      referralCount: 0,
      createdAt: new Date().toISOString()
    };
    data.users.push(user);
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // LOGIN
  // ============================================================
  if (url === '/api/login' && method === 'POST') {
    const { name, password } = body;
    const data = readData();
    const user = data.users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.password === password);
    if (!user) return res.json({ success: false, error: 'Nama atau password salah' });

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        referralCode: user.referralCode,
        discountBalance: user.discountBalance || 0,
        referralClicks: user.referralClicks || 0,
        referralCount: user.referralCount || 0
      }
    });
  }

  // ============================================================
  // LOGOUT
  // ============================================================
  if (url === '/api/logout' && method === 'POST') {
    return res.json({ success: true });
  }

  // ============================================================
  // USER PROFILE
  // ============================================================
  if (url === '/api/user/profile' && method === 'GET') {
    const name = req.headers['x-user-name'] || query.name;
    const data = readData();
    const user = data.users.find(u => u.name === name);
    if (!user) return res.json({ success: false });
    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        referralCode: user.referralCode,
        discountBalance: user.discountBalance || 0,
        referralClicks: user.referralClicks || 0,
        referralCount: user.referralCount || 0
      }
    });
  }

  // ============================================================
  // USER ORDERS
  // ============================================================
  if (url === '/api/user/orders' && method === 'GET') {
    const name = req.headers['x-user-name'] || query.name;
    const data = readData();
    const orders = data.orders.filter(o => o.customerName === name);
    return res.json({ success: true, orders });
  }

  // ============================================================
  // USER DEPOSITS
  // ============================================================
  if (url === '/api/user/deposits' && method === 'GET') {
    const name = req.headers['x-user-name'] || query.name;
    const data = readData();
    const deposits = data.deposits.filter(d => d.userName === name);
    return res.json({ success: true, deposits });
  }

  // ============================================================
  // USER DEPOSIT DETAIL
  // ============================================================
  if (url.startsWith('/api/user/deposit/') && method === 'GET') {
    const id = url.split('/').pop();
    const data = readData();
    const deposit = data.deposits.find(d => String(d.id) === id);
    if (!deposit) return res.json({ success: false });
    return res.json({ success: true, deposit });
  }

  // ============================================================
  // SAVE DEPOSIT
  // ============================================================
  if (url === '/api/user/deposit-save' && method === 'POST') {
    const { amount, qrisId, qrisImage, expiredAt, userName } = body;
    const data = readData();
    const deposit = {
      id: Date.now(),
      userName: userName || 'Guest',
      amount,
      qrisId,
      qrisImage,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiredAt: expiredAt || new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
    data.deposits.push(deposit);
    writeData(data);
    return res.json({ success: true, depId: deposit.id });
  }

  // ============================================================
  // CANCEL DEPOSIT
  // ============================================================
  if (url.startsWith('/api/user/cancel-deposit/') && method === 'POST') {
    const id = url.split('/').pop();
    const data = readData();
    const deposit = data.deposits.find(d => String(d.id) === id);
    if (!deposit) return res.json({ success: false, error: 'Deposit tidak ditemukan' });
    if (deposit.status !== 'pending') return res.json({ success: false, error: 'Deposit sudah tidak bisa dibatalkan' });
    deposit.status = 'cancelled';
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // USER WITHDRAWALS
  // ============================================================
  if (url === '/api/user/withdrawals' && method === 'GET') {
    const name = req.headers['x-user-name'] || query.name;
    const data = readData();
    const withdrawals = data.withdrawals.filter(w => w.userName === name);
    return res.json({ success: true, withdrawals });
  }

  // ============================================================
  // WITHDRAW
  // ============================================================
  if (url === '/api/user/withdraw' && method === 'POST') {
    const { amount, paymentMethod, paymentNumber, userName } = body;
    const data = readData();
    const user = data.users.find(u => u.name === userName);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan' });
    if ((user.discountBalance || 0) < amount) return res.json({ success: false, error: 'Saldo tidak cukup' });

    user.discountBalance -= amount;
    data.withdrawals.push({
      id: Date.now(),
      userName,
      amount,
      paymentMethod,
      paymentNumber,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // CHANGE PASSWORD
  // ============================================================
  if (url === '/api/user/change-password' && method === 'POST') {
    const { oldPassword, newPassword, userName } = body;
    const data = readData();
    const user = data.users.find(u => u.name === userName);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan' });
    if (user.password !== oldPassword) return res.json({ success: false, error: 'Password lama salah' });
    user.password = newPassword;
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: CHECK IP
  // ============================================================
  if (url === '/api/admin/check-ip' && method === 'GET') {
    const data = readData();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const isAdmin = data.adminIP === ip;
    return res.json({ isAdmin, hasAdmin: !!data.adminIP });
  }

  // ============================================================
  // ADMIN: SET IP
  // ============================================================
  if (url === '/api/admin/set-ip' && method === 'POST') {
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Kunci salah' });
    const data = readData();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    data.adminIP = ip;
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: RESET IP
  // ============================================================
  if (url === '/api/admin/reset-ip' && method === 'POST') {
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Kunci salah' });
    const data = readData();
    data.adminIP = null;
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: STATS
  // ============================================================
  if (url === '/api/admin/stats' && method === 'GET') {
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const orders = data.orders || [];
    const totalRevenue = orders.filter(o => o.status === 'paid').reduce((sum, o) => sum + (o.totalAmount || o.price || 0), 0);
    return res.json({
      success: true,
      stats: {
        totalProducts: (data.products || []).length,
        totalOrders: orders.length,
        totalRevenue,
        totalUsers: (data.users || []).length,
        totalWithdrawals: (data.withdrawals || []).length,
        totalDeposits: (data.deposits || []).length,
        pendingReferrals: data.orders.filter(o => o.status === 'pending' && o.referrerCode).length
      }
    });
  }

  // ============================================================
  // ADMIN: ORDERS
  // ============================================================
  if (url === '/api/admin/orders' && method === 'GET') {
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    return res.json({ success: true, orders: data.orders || [] });
  }

  // ============================================================
  // ADMIN: PRODUCTS
  // ============================================================
  if (url === '/api/admin/products' && method === 'GET') {
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    return res.json({ success: true, products: data.products || [] });
  }

  // ============================================================
  // ADMIN: GET SINGLE PRODUCT
  // ============================================================
  if (url.startsWith('/api/admin/product/') && method === 'GET') {
    const id = parseInt(url.split('/').pop());
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const product = data.products.find(p => p.id === id);
    if (!product) return res.json({ success: false });
    return res.json({ success: true, product });
  }

  // ============================================================
  // ADMIN: ADD PRODUCT
  // ============================================================
  if (url === '/api/admin/product' && method === 'POST') {
    const { adminKey, name, description, price, stock, itemType, itemContent, bonusType, bonusContent } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const product = {
      id: Date.now(),
      name,
      description: description || '',
      price: parseInt(price) || 0,
      stock: parseInt(stock) || 1,
      itemType: itemType || 'text',
      itemContent: itemContent || '',
      bonusType: bonusType || 'none',
      bonusContent: bonusContent || '',
      createdAt: new Date().toISOString()
    };
    data.products.push(product);
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: UPDATE PRODUCT
  // ============================================================
  if (url.startsWith('/api/admin/product/') && method === 'PUT') {
    const id = parseInt(url.split('/').pop());
    const { adminKey, name, description, price, stock, itemType, itemContent, bonusType, bonusContent } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const product = data.products.find(p => p.id === id);
    if (!product) return res.json({ success: false, error: 'Produk tidak ditemukan' });
    product.name = name || product.name;
    product.description = description || product.description;
    product.price = parseInt(price) || product.price;
    product.stock = parseInt(stock) || product.stock;
    product.itemType = itemType || product.itemType;
    product.itemContent = itemContent || product.itemContent;
    product.bonusType = bonusType || product.bonusType;
    product.bonusContent = bonusContent || product.bonusContent;
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: DELETE PRODUCT
  // ============================================================
  if (url.startsWith('/api/admin/product/') && method === 'DELETE') {
    const id = parseInt(url.split('/').pop());
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    data.products = data.products.filter(p => p.id !== id);
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: DELETE ORDER
  // ============================================================
  if (url.startsWith('/api/admin/order/') && method === 'DELETE') {
    const id = parseInt(url.split('/').pop());
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    data.orders = data.orders.filter(o => o.id !== id);
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: WITHDRAWALS
  // ============================================================
  if (url === '/api/admin/withdrawals' && method === 'GET') {
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    return res.json({ success: true, withdrawals: data.withdrawals || [] });
  }

  // ============================================================
  // ADMIN: UPDATE WITHDRAWAL
  // ============================================================
  if (url.startsWith('/api/admin/withdrawal/') && method === 'PUT') {
    const id = parseInt(url.split('/').pop());
    const { adminKey, status } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const wd = data.withdrawals.find(w => w.id === id);
    if (wd) { wd.status = status; writeData(data); }
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: SAVE QRIS ORDER
  // ============================================================
  if (url === '/api/admin/save-qris-order' && method === 'POST') {
    const { adminKey, qrisId, qrisImage, totalAmount, expiredAt, customerName } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const orderCode = generateOrderCode();
    data.orders.push({
      id: Date.now(),
      orderCode,
      productName: 'Deposit QRIS',
      customerName: customerName || 'Guest',
      qrisId,
      qrisImage,
      totalAmount: parseInt(totalAmount) || 0,
      price: parseInt(totalAmount) || 0,
      itemType: 'text',
      productCode: 'Deposit via QRIS',
      bonusContent: '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiredAt: expiredAt || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      productId: null
    });
    writeData(data);
    return res.json({ success: true, orderCode });
  }

  // ============================================================
  // ADMIN: TOGGLE MAINTENANCE
  // ============================================================
  if (url === '/api/admin/toggle-maintenance' && method === 'POST') {
    const { adminKey, maintenance } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    data.maintenance = maintenance;
    writeData(data);
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: RESET ORDERS
  // ============================================================
  if (url === '/api/admin/reset-orders' && method === 'POST') {
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const before = data.orders.length;
    data.orders = data.orders.filter(o => o.status === 'paid');
    writeData(data);
    return res.json({ success: true, deletedCount: before - data.orders.length });
  }

  // ============================================================
  // ADMIN: BACKUP
  // ============================================================
  if (url === '/api/admin/backup' && method === 'POST') {
    const { adminKey } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ success: true, message: 'Backup berhasil' });
  }

  // ============================================================
  // ADMIN: BROADCAST
  // ============================================================
  if (url === '/api/admin/broadcast' && method === 'POST') {
    const { adminKey, message } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    // Broadcast ke semua user (simulasi)
    return res.json({ success: true, sentCount: 0 });
  }

  // ============================================================
  // ADMIN: PENDING REFERRALS
  // ============================================================
  if (url === '/api/admin/pending-referrals' && method === 'GET') {
    const { adminKey } = query;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const pending = data.orders.filter(o => o.status === 'pending' && o.referrerCode);
    return res.json({ success: true, pending });
  }

  // ============================================================
  // ADMIN: APPROVE REFERRAL
  // ============================================================
  if (url === '/api/admin/approve-referral' && method === 'POST') {
    const { adminKey, orderCode } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const order = data.orders.find(o => o.orderCode === orderCode);
    if (order) {
      order.referralStatus = 'approved';
      const referrer = data.users.find(u => u.referralCode === order.referrerCode);
      if (referrer) referrer.referralCount = (referrer.referralCount || 0) + 1;
      writeData(data);
    }
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: REJECT REFERRAL
  // ============================================================
  if (url === '/api/admin/reject-referral' && method === 'POST') {
    const { adminKey, orderCode } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const order = data.orders.find(o => o.orderCode === orderCode);
    if (order) {
      order.referralStatus = 'rejected';
      writeData(data);
    }
    return res.json({ success: true });
  }

  // ============================================================
  // ADMIN: ADD BALANCE
  // ============================================================
  if (url === '/api/admin/add-balance' && method === 'POST') {
    const { adminKey, referralCode, amount } = body;
    if (adminKey !== 'nisaimut') return res.status(401).json({ error: 'Unauthorized' });
    const data = readData();
    const user = data.users.find(u => u.referralCode === referralCode);
    if (!user) return res.json({ success: false, error: 'User tidak ditemukan' });
    user.discountBalance = (user.discountBalance || 0) + (parseInt(amount) || 500);
    writeData(data);
    return res.json({ success: true, message: 'Saldo ditambahkan' });
  }

  // ============================================================
  // PING TELEGRAM
  // ============================================================
  if (url === '/api/ping-telegram' && method === 'GET') {
    return res.json({ status: 'ok', message: 'Telegram connected' });
  }

  // ============================================================
  // HEALTH CHECK
  // ============================================================
  if (url === '/api/health' && method === 'GET') {
    return res.json({ status: 'ok', timestamp: new Date().toISOString() });
  }

  // ============================================================
  // 404
  // ============================================================
  return res.status(404).json({ error: 'Endpoint tidak ditemukan' });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
