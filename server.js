'use strict';

const express   = require('express');
const mysql     = require('mysql2/promise');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

// ──────────────────────────────────────────────
//  App bootstrap
// ──────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 8080;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ──────────────────────────────────────────────
//  Database pool  (matches YOUR fashiondb)
// ──────────────────────────────────────────────
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool.promise();


(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected to fashiondb');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
  }
})();

// ──────────────────────────────────────────────
//  JWT helpers
// ──────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ══════════════════════════════════════════════
//  AUTH  — uses your `users` table
//  columns: id, name, email, password, address
// ══════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, address } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (name, email, password, address) VALUES (?,?,?,?)',
      [name, email, hash, address || null]
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
      'SELECT id, name, email, password, address FROM users WHERE email = ?',
      [email]
    );
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _, ...user } = rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get logged-in user profile
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, address FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
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
    const [rows] = await pool.execute('SELECT * FROM categories');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  PRODUCTS
//  columns: id, name, price, category_id,
//           brand, size, image, description
//  stock lives in `inventory` (product_id, stock)
// ══════════════════════════════════════════════
app.get('/api/products', async (req, res) => {
  const { category, search, brand } = req.query;
  const conditions = ['1=1'];
  const params     = [];

  if (category) { conditions.push('p.category_id = ?'); params.push(category); }
  if (brand)    { conditions.push('p.brand = ?');        params.push(brand); }
  if (search)   { conditions.push('p.name LIKE ?');      params.push(`%${search}%`); }

  const where = conditions.join(' AND ');
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, c.name AS category_name,
              COALESCE(i.stock, 0) AS stock
         FROM products p
         LEFT JOIN categories c  ON c.id = p.category_id
         LEFT JOIN inventory   i ON i.product_id = p.id
        WHERE ${where}
        ORDER BY p.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT p.*, c.name AS category_name,
              COALESCE(i.stock, 0) AS stock
         FROM products p
         LEFT JOIN categories c  ON c.id = p.category_id
         LEFT JOIN inventory   i ON i.product_id = p.id
        WHERE p.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });

    const [reviews] = await pool.execute(
      `SELECT r.*, u.name AS reviewer
         FROM reviews r
         JOIN users u ON u.id = r.user_id
        WHERE r.product_id = ?
        ORDER BY r.id DESC LIMIT 10`,
      [req.params.id]
    );
    res.json({ ...rows[0], reviews });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: add product
app.post('/api/products', authMiddleware, async (req, res) => {
  const { name, price, category_id, brand, size, image, description, stock } = req.body;
  if (!name || !price || !category_id)
    return res.status(400).json({ error: 'name, price, category_id required' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO products (name, price, category_id, brand, size, image, description) VALUES (?,?,?,?,?,?,?)',
      [name, price, category_id, brand||null, size||null, image||null, description||null]
    );
    const productId = result.insertId;
    if (stock !== undefined) {
      await conn.execute(
        'INSERT INTO inventory (product_id, stock) VALUES (?,?)',
        [productId, stock]
      );
    }
    await conn.commit();
    res.status(201).json({ id: productId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

// ══════════════════════════════════════════════
//  CART  — uses your `cart` table
//  columns: id, user_id, product_id, quantity
// ══════════════════════════════════════════════
app.get('/api/cart', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.id, c.quantity, c.product_id,
              p.name, p.price, p.image, p.size, p.brand
         FROM cart c
         JOIN products p ON p.id = c.product_id
        WHERE c.user_id = ?`,
      [req.user.id]
    );
    const total = rows.reduce((sum, r) => sum + r.price * r.quantity, 0);
    res.json({ items: rows, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', authMiddleware, async (req, res) => {
  const { product_id, quantity = 1 } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  try {
    // If item already in cart, increase quantity
    const [existing] = await pool.execute(
      'SELECT id, quantity FROM cart WHERE user_id = ? AND product_id = ?',
      [req.user.id, product_id]
    );
    if (existing.length) {
      await pool.execute(
        'UPDATE cart SET quantity = quantity + ? WHERE id = ?',
        [quantity, existing[0].id]
      );
    } else {
      await pool.execute(
        'INSERT INTO cart (user_id, product_id, quantity) VALUES (?,?,?)',
        [req.user.id, product_id, quantity]
      );
    }
    res.json({ message: 'Added to cart' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/cart/:id', authMiddleware, async (req, res) => {
  const { quantity } = req.body;
  if (!quantity || quantity < 1)
    return res.status(400).json({ error: 'quantity must be at least 1' });
  try {
    await pool.execute(
      'UPDATE cart SET quantity = ? WHERE id = ? AND user_id = ?',
      [quantity, req.params.id, req.user.id]
    );
    res.json({ message: 'Cart updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cart/:id', authMiddleware, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM cart WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Removed from cart' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear entire cart
app.delete('/api/cart', authMiddleware, async (req, res) => {
  try {
    await pool.execute('DELETE FROM cart WHERE user_id = ?', [req.user.id]);
    res.json({ message: 'Cart cleared' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  WISHLIST
//  columns: id, user_id, product_id
// ══════════════════════════════════════════════
app.get('/api/wishlist', authMiddleware, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT w.id, w.product_id, p.name, p.price, p.image, p.brand
         FROM wishlist w
         JOIN products p ON p.id = w.product_id
        WHERE w.user_id = ?`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/wishlist', authMiddleware, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  try {
    await pool.execute(
      'INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?,?)',
      [req.user.id, product_id]
    );
    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/wishlist/:product_id', authMiddleware, async (req, res) => {
  try {
    await pool.execute(
      'DELETE FROM wishlist WHERE user_id = ? AND product_id = ?',
      [req.user.id, req.params.product_id]
    );
    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  ORDERS
//  orders   : id, user_id, total_amount, order_status, created_at
//  order_items: id, order_id, product_id, quantity, price
//  payments : id, order_id, payment_method, payment_status, transaction_id
// ══════════════════════════════════════════════
app.post('/api/orders', authMiddleware, async (req, res) => {
  const { payment_method = 'cod', transaction_id = null } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Fetch user's cart
    const [cartRows] = await conn.execute(
      `SELECT c.product_id, c.quantity, p.price,
              COALESCE(i.stock, 0) AS stock
         FROM cart c
         JOIN products  p ON p.id = c.product_id
         LEFT JOIN inventory i ON i.product_id = c.product_id
        WHERE c.user_id = ?`,
      [req.user.id]
    );
    if (!cartRows.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Stock check
    for (const item of cartRows) {
      if (item.quantity > item.stock) {
        await conn.rollback();
        return res.status(409).json({
          error: `Not enough stock for product #${item.product_id}`
        });
      }
    }

    const total_amount = cartRows.reduce((s, i) => s + i.price * i.quantity, 0);

    // Create order
    const [orderResult] = await conn.execute(
      "INSERT INTO orders (user_id, total_amount, order_status) VALUES (?,?,'pending')",
      [req.user.id, total_amount]
    );
    const order_id = orderResult.insertId;

    // Insert order items + reduce stock
    for (const item of cartRows) {
      await conn.execute(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)',
        [order_id, item.product_id, item.quantity, item.price]
      );
      await conn.execute(
        'UPDATE inventory SET stock = stock - ? WHERE product_id = ?',
        [item.quantity, item.product_id]
      );
    }

    // Create payment record
    await conn.execute(
      'INSERT INTO payments (order_id, payment_method, payment_status, transaction_id) VALUES (?,?,?,?)',
      [order_id, payment_method, payment_method === 'cod' ? 'pending' : 'paid', transaction_id]
    );

    // Clear cart
    await conn.execute('DELETE FROM cart WHERE user_id = ?', [req.user.id]);

    await conn.commit();
    res.status(201).json({ message: 'Order placed successfully', order_id, total_amount });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    conn.release();
  }
});

// Get all orders for logged-in user
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT o.*, p.payment_method, p.payment_status
         FROM orders o
         LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single order with items
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT o.*, p.payment_method, p.payment_status, p.transaction_id
         FROM orders o
         LEFT JOIN payments p ON p.order_id = o.id
        WHERE o.id = ? AND o.user_id = ?`,
      [req.params.id, req.user.id]
    );
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });

    const [items] = await pool.execute(
      `SELECT oi.*, pr.name, pr.image, pr.brand
         FROM order_items oi
         JOIN products pr ON pr.id = oi.product_id
        WHERE oi.order_id = ?`,
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
    return res.status(400).json({ error: 'Rating between 1 and 5 required' });
  try {
    await pool.execute(
      'INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, rating, comment || null]
    );
    res.status(201).json({ message: 'Review added' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'You already reviewed this product' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  INVENTORY  (check stock for a product)
// ══════════════════════════════════════════════
app.get('/api/inventory/:product_id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT stock FROM inventory WHERE product_id = ?',
      [req.params.product_id]
    );
    res.json({ stock: rows.length ? rows[0].stock : 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  COUPONS
// ══════════════════════════════════════════════
app.post('/api/coupons/validate', authMiddleware, async (req, res) => {
  const { code, order_value } = req.body;
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM coupons WHERE code = ? AND is_active = 1
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired coupon' });
    const c = rows[0];
    const discount = c.discount_type === 'percent'
      ? ((order_value * c.discount_value) / 100).toFixed(2)
      : c.discount_value.toFixed(2);
    res.json({ valid: true, discount });
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

// SPA catch-all
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ──────────────────────────────────────────────
//  Start
// ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 FashionHub running on port ${PORT}`)
);
