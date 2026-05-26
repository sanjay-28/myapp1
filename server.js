'use strict';

const express    = require('express');
const mysql      = require('mysql2/promise');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

// ──────────────────────────────────────────────
//  App bootstrap
// ──────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 8080;

// ──────────────────────────────────────────────
//  Security middleware
// ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs : 15 * 60 * 1000, // 15 minutes
  max      : 200,
  message  : { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ──────────────────────────────────────────────
//  Static files
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
//  Database pool
// ──────────────────────────────────────────────
const pool = mysql.createPool({
  host               : process.env.DB_HOST     || '127.0.0.1',
  port               : parseInt(process.env.DB_PORT || '3306'),
  user               : process.env.DB_USER     || 'fashionuser',
  password           : process.env.DB_PASSWORD || '',
  database           : process.env.DB_NAME     || 'fashiondb',
  waitForConnections : true,
  connectionLimit    : 10,
  queueLimit         : 0,
  enableKeepAlive    : true,
  keepAliveInitialDelay: 0
});

// Verify DB on startup
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
  }
})();

// ──────────────────────────────────────────────
//  JWT auth middleware
// ──────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ──────────────────────────────────────────────
//  Helper
// ──────────────────────────────────────────────
const paginate = (req) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '12')));
  return { page, limit, offset: (page - 1) * limit };
};

// ══════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password_hash, phone) VALUES (?,?,?,?)',
      [name, email, hash, phone || null]
    );
    res.status(201).json({ message: 'Account created', userId: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' });
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, password_hash, role FROM users WHERE email=? AND is_active=1',
      [email]
    );
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
      return res.status(401).json({ error: 'Invalid credentials' });

    const { password_hash, ...user } = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  PRODUCTS ROUTES
// ══════════════════════════════════════════════
app.get('/api/products', async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const { category, search, featured, sort = 'created_at' } = req.query;

  const allowed = ['price', '-price', 'rating', 'created_at'];
  const orderMap = { price: 'p.price ASC', '-price': 'p.price DESC', rating: 'p.rating DESC', created_at: 'p.created_at DESC' };
  const orderBy = orderMap[allowed.includes(sort) ? sort : 'created_at'];

  const conditions = ['p.is_active = 1'];
  const params     = [];

  if (category)  { conditions.push('c.slug = ?');         params.push(category); }
  if (search)    { conditions.push('p.name LIKE ?');       params.push(`%${search}%`); }
  if (featured)  { conditions.push('p.is_featured = 1'); }

  const where = conditions.join(' AND ');
  try {
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM products p JOIN categories c ON c.id=p.category_id WHERE ${where}`,
      params
    );
    const [rows] = await pool.execute(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM products p JOIN categories c ON c.id=p.category_id
        WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/products/:slug', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM products p JOIN categories c ON c.id=p.category_id
        WHERE p.slug=? AND p.is_active=1`,
      [req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });

    const [reviews] = await pool.execute(
      `SELECT r.rating, r.comment, r.created_at, u.name AS reviewer
         FROM reviews r JOIN users u ON u.id=r.user_id
        WHERE r.product_id=? ORDER BY r.created_at DESC LIMIT 10`,
      [rows[0].id]
    );
    res.json({ ...rows[0], reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: create product
app.post('/api/products', authMiddleware, adminMiddleware, async (req, res) => {
  const { category_id, name, slug, description, price, sale_price, stock, image_url, sizes, colors, is_featured } = req.body;
  if (!category_id || !name || !slug || !price)
    return res.status(400).json({ error: 'category_id, name, slug, price are required' });
  try {
    const [result] = await pool.execute(
      `INSERT INTO products (category_id,name,slug,description,price,sale_price,stock,image_url,sizes,colors,is_featured)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [category_id, name, slug, description||null, price, sale_price||null, stock||0,
       image_url||null, JSON.stringify(sizes||[]), JSON.stringify(colors||[]), is_featured?1:0]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  CATEGORIES
// ══════════════════════════════════════════════
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, slug, description, image_url FROM categories WHERE is_active=1 ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  CART ROUTES (authenticated)
// ══════════════════════════════════════════════
app.get('/api/cart', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ci.id, ci.qty, ci.size, ci.color,
              p.id AS product_id, p.name, p.slug, p.price, p.sale_price, p.image_url
         FROM cart_items ci JOIN products p ON p.id=ci.product_id
        WHERE ci.user_id=?`,
      [req.user.id]
    );
    const total = rows.reduce((sum, r) => sum + (r.sale_price || r.price) * r.qty, 0);
    res.json({ items: rows, total: total.toFixed(2) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', authMiddleware, async (req, res) => {
  const { product_id, qty = 1, size, color } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  try {
    await pool.execute(
      `INSERT INTO cart_items (user_id, product_id, qty, size, color)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)`,
      [req.user.id, product_id, qty, size||null, color||null]
    );
    res.json({ message: 'Added to cart' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cart/:id', authMiddleware, async (req, res) => {
  try {
    await pool.execute('DELETE FROM cart_items WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ message: 'Removed from cart' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  ORDERS ROUTES
// ══════════════════════════════════════════════
app.post('/api/orders', authMiddleware, async (req, res) => {
  const { address_id, payment_method = 'cod', coupon_code, notes } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Fetch cart
    const [cartItems] = await conn.execute(
      `SELECT ci.qty, ci.size, ci.color,
              p.id AS product_id, p.price, p.sale_price, p.stock
         FROM cart_items ci JOIN products p ON p.id=ci.product_id
        WHERE ci.user_id=?`,
      [req.user.id]
    );
    if (!cartItems.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Stock check
    for (const item of cartItems) {
      if (item.qty > item.stock) {
        await conn.rollback();
        return res.status(409).json({ error: `Insufficient stock for product #${item.product_id}` });
      }
    }

    const subtotal = cartItems.reduce((s, i) => s + (i.sale_price || i.price) * i.qty, 0);
    let discount = 0;

    // Coupon
    if (coupon_code) {
      const [coupons] = await conn.execute(
        `SELECT * FROM coupons WHERE code=? AND is_active=1
           AND (expires_at IS NULL OR expires_at > NOW())
           AND (max_uses IS NULL OR used_count < max_uses)
           AND min_order_value <= ?`,
        [coupon_code, subtotal]
      );
      if (coupons.length) {
        const c = coupons[0];
        discount = c.discount_type === 'percent'
          ? (subtotal * c.discount_value / 100)
          : c.discount_value;
        await conn.execute('UPDATE coupons SET used_count=used_count+1 WHERE id=?', [c.id]);
      }
    }

    const shipping_fee = subtotal >= 999 ? 0 : 99;
    const total = Math.max(0, subtotal - discount + shipping_fee);

    // Create order
    const [orderResult] = await conn.execute(
      `INSERT INTO orders (user_id, address_id, payment_method, subtotal, discount, shipping_fee, total, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.id, address_id||null, payment_method, subtotal, discount, shipping_fee, total, notes||null]
    );
    const order_id = orderResult.insertId;

    // Order items + decrement stock
    for (const item of cartItems) {
      const unit_price  = item.sale_price || item.price;
      const total_price = unit_price * item.qty;
      await conn.execute(
        `INSERT INTO order_items (order_id, product_id, qty, size, color, unit_price, total_price)
           VALUES (?,?,?,?,?,?,?)`,
        [order_id, item.product_id, item.qty, item.size, item.color, unit_price, total_price]
      );
      await conn.execute(
        'UPDATE products SET stock = stock - ? WHERE id=?',
        [item.qty, item.product_id]
      );
    }

    // Clear cart
    await conn.execute('DELETE FROM cart_items WHERE user_id=?', [req.user.id]);
    await conn.commit();

    res.status(201).json({ message: 'Order placed', order_id, total });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT o.id, o.status, o.payment_method, o.total, o.created_at,
              COUNT(oi.id) AS item_count
         FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
        WHERE o.user_id=? GROUP BY o.id ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      'SELECT * FROM orders WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });

    const [items] = await pool.execute(
      `SELECT oi.*, p.name, p.image_url FROM order_items oi
         JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?`,
      [req.params.id]
    );
    res.json({ ...orders[0], items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  REVIEWS
// ══════════════════════════════════════════════
app.post('/api/products/:id/reviews', authMiddleware, async (req, res) => {
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating 1-5 required' });
  try {
    await pool.execute(
      'INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, rating, comment||null]
    );
    // Recalculate average
    await pool.execute(
      `UPDATE products SET
         rating       = (SELECT ROUND(AVG(rating),1) FROM reviews WHERE product_id=?),
         review_count = (SELECT COUNT(*)              FROM reviews WHERE product_id=?)
       WHERE id=?`,
      [req.params.id, req.params.id, req.params.id]
    );
    res.status(201).json({ message: 'Review added' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'You have already reviewed this product' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  COUPON VALIDATION
// ══════════════════════════════════════════════
app.post('/api/coupons/validate', authMiddleware, async (req, res) => {
  const { code, order_value } = req.body;
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM coupons WHERE code=? AND is_active=1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (max_uses IS NULL OR used_count < max_uses)`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired coupon' });
    const c = rows[0];
    if (order_value < c.min_order_value)
      return res.status(400).json({ error: `Minimum order value ₹${c.min_order_value} required` });

    const discount = c.discount_type === 'percent'
      ? ((order_value * c.discount_value) / 100).toFixed(2)
      : c.discount_value.toFixed(2);
    res.json({ valid: true, discount_type: c.discount_type, discount_value: c.discount_value, discount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  ADMIN: basic dashboard stats
// ══════════════════════════════════════════════
app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [[{ total_orders }]]   = await pool.execute('SELECT COUNT(*) AS total_orders FROM orders');
    const [[{ revenue }]]        = await pool.execute("SELECT COALESCE(SUM(total),0) AS revenue FROM orders WHERE status != 'cancelled'");
    const [[{ total_products }]] = await pool.execute('SELECT COUNT(*) AS total_products FROM products WHERE is_active=1');
    const [[{ total_users }]]    = await pool.execute("SELECT COUNT(*) AS total_users FROM users WHERE role='customer'");
    const [recent]               = await pool.execute(
      'SELECT id, total, status, created_at FROM orders ORDER BY created_at DESC LIMIT 5'
    );
    res.json({ total_orders, revenue, total_products, total_users, recent_orders: recent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ──────────────────────────────────────────────
//  Health check
// ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ──────────────────────────────────────────────
//  SPA catch-all
// ──────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ──────────────────────────────────────────────
//  Start server
// ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 FashionHub server running on port ${PORT}`)
);
