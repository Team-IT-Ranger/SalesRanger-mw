/**
 * ============================================================
 *  VAN SALES — MIDDLEWARE API  (Node.js + Express)
 *  Deploy บน Railway — เชื่อมต่อ MySQL ด้วย connection pool
 *  Apps Script เรียก HTTP มาแทน JDBC โดยตรง
 * ============================================================
 */

require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===================== CONNECTION POOL =====================
// pool เก็บ connection ไว้ไม่ต้องสร้างใหม่ทุก request
const pools = {};

function getPool(schema) {
  if (!pools[schema]) {
    pools[schema] = mysql.createPool({
      host:               process.env.DB_HOST     || 'rbs-center.biz',
      port:               parseInt(process.env.DB_PORT || '3333'),
      user:               process.env.DB_USER     || 'user_tnk',
      password:           process.env.DB_PASSWORD || 'Tnk12345',
      database:           schema,
      waitForConnections: true,
      connectionLimit:    5,       // max 5 connections ต่อ schema
      queueLimit:         0,
      enableKeepAlive:    true,
      keepAliveInitialDelay: 0,
      ssl: false
    });
  }
  return pools[schema];
}

// ===================== AUTH MIDDLEWARE =====================
// ตรวจ API Key ง่ายๆ กัน public access
function authCheck(req, res, next) {
  //ปิดฟังกชั่นชั่วคราวเพื่อทดสอบ
  return next();
  
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

// ===================== ROUTES =====================

// Health check
app.get('/ping', (req, res) => {
  res.json({ success: true, message: 'Van Sales Middleware is alive', time: new Date().toISOString() });
});

// Main API endpoint
app.post('/api', authCheck, async (req, res) => {
  const { action, lineUserId, targetSchema, payload } = req.body;
  if (!action) return res.json({ success: false, message: 'Missing action' });

  try {
    switch (action) {
      case 'ping':         return res.json({ success: true, message: 'pong' });
      case 'getProfile':   return res.json(await getProfile(lineUserId));
      case 'getBootstrap': return res.json(await getBootstrap(lineUserId, targetSchema));
      case 'recordSale':   return res.json(await recordSale(lineUserId, targetSchema, payload));
      case 'restockVan':   return res.json(await restockVan(lineUserId, targetSchema, payload));
      case 'submitCount':  return res.json(await submitCount(lineUserId, targetSchema, payload));
      case 'checkInVisit': return res.json(await checkInVisit(lineUserId, targetSchema, payload));
      case 'addVisitNote': return res.json(await addVisitNote(lineUserId, targetSchema, payload));
      case 'addCompetitor':return res.json(await addCompetitor(lineUserId, targetSchema, payload));
      case 'addCustomer':  return res.json(await addCustomer(lineUserId, targetSchema, payload));
      case 'getDashboard': return res.json(await getDashboard(lineUserId, targetSchema));
      case 'getRecentSales':return res.json(await getRecentSales(lineUserId, targetSchema, payload));
      default: return res.json({ success: false, message: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error(`[${action}] ${err.message}`);
    return res.json({ success: false, message: err.message });
  }
});


// ===================== PERMISSION =====================
const CENTRAL_DB = process.env.DB_NAME || 'thanatkorn';

async function checkPermission(lineUserId, targetSchema) {
  const res = {
    isAllowed: false, role: 'user', schema: '',
    can_select: false, can_insert: false, can_update: false, can_delete: false
  };
  if (!lineUserId) return res;

  const pool = getPool(CENTRAL_DB);
  const [users] = await pool.query(
    'SELECT role, display_name FROM liff_users WHERE line_user_id = ?', [lineUserId]
  );
  if (!users.length) return res;

  res.role = users[0].role;
  if (res.role === 'super_admin') {
    return { ...res, isAllowed: true, schema: targetSchema,
      can_select: true, can_insert: true, can_update: true, can_delete: true };
  }

  const [perms] = await pool.query(
    'SELECT schema_name, can_select, can_insert, can_update, can_delete FROM liff_permissions WHERE line_user_id = ? AND schema_name = ?',
    [lineUserId, targetSchema]
  );
  if (perms.length) {
    res.isAllowed   = true;
    res.schema      = perms[0].schema_name;
    res.can_select  = !!perms[0].can_select;
    res.can_insert  = !!perms[0].can_insert;
    res.can_update  = !!perms[0].can_update;
    res.can_delete  = !!perms[0].can_delete;
  }
  return res;
}


// ===================== PROFILE =====================
async function getProfile(lineUserId) {
  const pool = getPool(CENTRAL_DB);
  const [users] = await pool.query(
    'SELECT role, display_name FROM liff_users WHERE line_user_id = ?', [lineUserId]
  );
  if (!users.length) return { success: false, registered: false, message: 'ไม่พบผู้ใช้ กรุณาติดต่อแอดมิน' };

  const { role, display_name } = users[0];
  let schemas = [];

  if (role === 'super_admin') {
    const [rows] = await pool.query('SELECT DISTINCT schema_name FROM liff_permissions');
    schemas = rows.map(r => r.schema_name);
  } else {
    const [rows] = await pool.query(
      'SELECT schema_name FROM liff_permissions WHERE line_user_id = ?', [lineUserId]
    );
    schemas = rows.map(r => r.schema_name);
  }
  return { success: true, registered: true, role, displayName: display_name, schemas };
}


// ===================== BOOTSTRAP =====================
async function getBootstrap(lineUserId, targetSchema) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_select)
    return { success: false, message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล' };

  const pool = getPool(perm.schema);

  // ดึงพร้อมกัน 3 query (parallel) — เร็วกว่า sequential มาก
  const [itemRows, custRows, ruleRows] = await Promise.all([
    pool.query(
      `SELECT p.ItemCode, p.ItemDesc, p.Price, p.Packsize,
              p.ClassCode, p.CategoryCode,
              COALESCE(wh.OnhandQty,0) AS wh_qty,
              COALESCE(vn.OnhandQty,0) AS vn_qty
       FROM item p
       JOIN unitofitem u ON u.ItemCode=p.ItemCode AND u.UnitCode='CT'
       LEFT JOIN stockonvan wh ON wh.ItemCode=p.ItemCode AND wh.VanNo='BASE'
       LEFT JOIN stockonvan vn ON vn.ItemCode=p.ItemCode AND vn.VanNo='VN01'
       ORDER BY p.ItemDesc`
    ),
    pool.query(
      `SELECT CustNo, CustName, GroupCode, ShopTypeCode,
              Phone, Addr1, Latitude, Longitude
       FROM customer ORDER BY CustName LIMIT 500`
    ),
    pool.query(
      `SELECT * FROM discount_rules
       WHERE is_active=1
         AND (start_date IS NULL OR start_date<=CURDATE())
         AND (end_date IS NULL OR end_date>=CURDATE())
       ORDER BY priority`
    ).catch(() => [[]])  // ถ้าตารางไม่มีไม่ error
  ]);

  const item = itemRows[0].map(r => ({
    id:        r.ItemCode,
    name:      r.ItemDesc,
    price:     parseFloat(r.Price),
    unit:      r.Packsize,
    groupId:   r.ClassCode,
    warehouse: r.wh_qty,
    vanStock:  r.vn_qty
  }));

  const customer = custRows[0].map(r => ({
    id:       r.CustNo,
    name:     r.CustName,
    groupId:  r.GroupCode,
    shopType: r.ShopTypeCode,
    phone:    r.Phone,
    address:  r.Addr1,
    lat:      parseFloat(r.Latitude)  || 0,
    lng:      parseFloat(r.Longitude) || 0
  }));

  const rules = ruleRows[0].map(r => ({
    id:              r.id,
    name:            r.rule_name,
    productGroupId:  r.product_group_id,
    productId:       r.product_id,
    customerGroupId: r.customer_group_id,
    minQty:          r.min_qty,
    minAmount:       parseFloat(r.min_amount),
    discountType:    r.discount_type,
    discountValue:   parseFloat(r.discount_value),
    freeProductId:   r.free_product_id,
    freeQty:         r.free_qty,
    priority:        r.priority,
    stackable:       !!r.stackable
  }));

  return { success: true, item, customer, rules,
    perm: { insert: perm.can_insert, update: perm.can_update }, role: perm.role };
}


// ===================== RECORD SALE =====================
async function recordSale(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_insert)
    return { success: false, message: 'ไม่มีสิทธิ์บันทึกการขาย' };

  const items     = payload.items     || [];
  const freeGoods = (payload.freeGoods||[]).filter(f => f.applied !== false);
  const billDiscount = parseFloat(payload.discountTotal) || 0;
  const appliedRules = payload.appliedRules || [];
  if (!items.length) return { success: false, message: 'ไม่มีรายการสินค้า' };

  const pool = getPool(perm.schema);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const subtotal = items.reduce((s,it) => s + it.price*it.qty, 0);
    const total    = subtotal - billDiscount;
    const orderCode = genCode('SO');

    const [bres] = await conn.query(
      `INSERT INTO sales_orders
       (order_code,customer_id,visit_id,subtotal,discount_total,total_amount,
        payment_type,sale_by_line_id,latitude,longitude,google_map,note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderCode, payload.customerId||0, payload.visitId||0,
       subtotal, billDiscount, total,
       payload.paymentType||'cash', lineUserId,
       payload.latitude||0, payload.longitude||0,
       payload.googleMap||'', payload.note||'']
    );
    const orderId = bres.insertId;

    // order items
    const itemVals = [
      ...items.map(it    => [orderId, it.productId, it.qty, it.price, it.price*it.qty, 0]),
      ...freeGoods.map(f => [orderId, f.productId,  f.qty,  0,        0,               1])
    ];
    if (itemVals.length)
      await conn.query('INSERT INTO order_items (order_id,product_id,qty,price,line_total,is_free) VALUES ?', [itemVals]);

    // discount log
    const discVals = [
      ...appliedRules.map(r => [orderId, r.ruleId||0, r.ruleName||'', r.type||'amount', r.value||0, 0, 0, 1]),
      ...freeGoods.map(f    => [orderId, f.ruleId||0, f.ruleName||'', 'free_goods',      0, f.productId, f.qty, 1])
    ];
    if (discVals.length)
      await conn.query(
        'INSERT INTO order_discounts (order_id,rule_id,rule_name,discount_type,discount_value,free_product_id,free_qty,applied) VALUES ?',
        [discVals]
      );

    await conn.commit();
    return { success: true, message: 'บันทึกการขายสำเร็จ', orderId, orderCode, total, discount: billDiscount };
  } catch (err) {
    await conn.rollback();
    return { success: false, message: 'บันทึกไม่สำเร็จ: ' + err.message };
  } finally {
    conn.release();
  }
}


// ===================== RESTOCK =====================
async function restockVan(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_update) return { success: false, message: 'ไม่มีสิทธิ์เบิกสินค้า' };
  const items = payload.items || [];
  if (!items.length) return { success: false, message: 'ไม่มีรายการเบิก' };

  const pool = getPool(perm.schema);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const it of items) {
      await conn.query('UPDATE products SET stock_qty=stock_qty-? WHERE id=?', [it.qty, it.productId]);
      await conn.query(
        'INSERT INTO van_stock (line_user_id,product_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=qty+VALUES(qty)',
        [lineUserId, it.productId, it.qty]
      );
    }
    await conn.commit();
    return { success: true, message: 'เบิกของขึ้นรถสำเร็จ' };
  } catch (err) {
    await conn.rollback();
    return { success: false, message: err.message };
  } finally { conn.release(); }
}


// ===================== STOCK COUNT =====================
async function submitCount(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_update) return { success: false, message: 'ไม่มีสิทธิ์ตรวจนับ' };
  const items = payload.items || [];
  const pool  = getPool(perm.schema);
  const conn  = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const it of items) {
      const [[vs]] = await conn.query(
        'SELECT qty FROM van_stock WHERE line_user_id=? AND product_id=?', [lineUserId, it.productId]
      );
      const sysQ   = vs ? vs.qty : 0;
      const diff   = it.countedQty - sysQ;
      await conn.query(
        'INSERT INTO stock_counts (line_user_id,product_id,system_qty,counted_qty,diff_qty) VALUES (?,?,?,?,?)',
        [lineUserId, it.productId, sysQ, it.countedQty, diff]
      );
      await conn.query(
        'INSERT INTO van_stock (line_user_id,product_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=VALUES(qty)',
        [lineUserId, it.productId, it.countedQty]
      );
    }
    await conn.commit();
    return { success: true, message: 'บันทึกการตรวจนับสำเร็จ' };
  } catch (err) {
    await conn.rollback();
    return { success: false, message: err.message };
  } finally { conn.release(); }
}


// ===================== VISIT =====================
async function checkInVisit(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_insert) return { success: false, message: 'ไม่มีสิทธิ์เช็คอิน' };
  const pool = getPool(perm.schema);
  const [res] = await pool.query(
    'INSERT INTO visits (customer_id,line_user_id,latitude,longitude) VALUES (?,?,?,?)',
    [payload.customerId||0, lineUserId, payload.lat||0, payload.lng||0]
  );
  return { success: true, message: 'เช็คอินสำเร็จ', visitId: res.insertId };
}

async function addVisitNote(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_insert) return { success: false, message: 'ไม่มีสิทธิ์บันทึก' };
  const pool = getPool(perm.schema);
  await pool.query('INSERT INTO visit_notes (visit_id,note) VALUES (?,?)', [payload.visitId, payload.note||'']);
  return { success: true, message: 'บันทึกความคิดเห็นสำเร็จ' };
}

async function addCompetitor(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_insert) return { success: false, message: 'ไม่มีสิทธิ์บันทึก' };
  const pool = getPool(perm.schema);
  await pool.query(
    'INSERT INTO competitor_logs (visit_id,customer_id,competitor_name,product_name,price) VALUES (?,?,?,?,?)',
    [payload.visitId||0, payload.customerId||0, payload.competitorName||'', payload.productName||'', payload.price||0]
  );
  return { success: true, message: 'บันทึกข้อมูลคู่แข่งสำเร็จ' };
}


// ===================== CUSTOMER =====================
async function addCustomer(lineUserId, targetSchema, payload) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_insert) return { success: false, message: 'ไม่มีสิทธิ์เพิ่มลูกค้า' };
  if (!payload.name) return { success: false, message: 'กรุณาระบุชื่อลูกค้า' };
  const pool = getPool(perm.schema);
  const [res] = await pool.query(
    'INSERT INTO customers (customer_name,group_id,phone,tax_id,address,latitude,longitude,created_by) VALUES (?,?,?,?,?,?,?,?)',
    [payload.name, payload.groupId||0, payload.phone||'', payload.taxId||'',
     payload.address||'', payload.lat||0, payload.lng||0, lineUserId]
  );
  return { success: true, message: 'เพิ่มลูกค้าสำเร็จ', customerId: res.insertId };
}


// ===================== DASHBOARD =====================
async function getDashboard(lineUserId, targetSchema) {
  const perm = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_select) return { success: false, message: 'ไม่มีสิทธิ์ดูสรุป' };
  const pool = getPool(perm.schema);

  const [[summary]] = await pool.query(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(total_amount),0)    AS revenue,
            COALESCE(SUM(discount_total),0)  AS discount
     FROM sales_orders
     WHERE sale_by_line_id=? AND DATE(created_at)=CURDATE() AND status='completed'`,
    [lineUserId]
  );

  const [top] = await pool.query(
    `SELECT p.ItemDesc AS name, SUM(oi.qty) AS sold
     FROM order_items oi
     JOIN sales_orders so ON so.id=oi.order_id
     JOIN item p ON p.ItemCode=oi.product_id
     WHERE so.sale_by_line_id=? AND DATE(so.created_at)=CURDATE() AND oi.is_free=0
     GROUP BY oi.product_id ORDER BY sold DESC LIMIT 5`,
    [lineUserId]
  );

  return { success: true,
    bills:       summary.bills,
    revenue:     parseFloat(summary.revenue),
    discount:    parseFloat(summary.discount),
    topProducts: top
  };
}

async function getRecentSales(lineUserId, targetSchema, payload) {
  const perm  = await checkPermission(lineUserId, targetSchema);
  if (!perm.isAllowed || !perm.can_select) return { success: false, message: 'ไม่มีสิทธิ์' };
  const limit = parseInt(payload?.limit) || 10;
  const pool  = getPool(perm.schema);
  const [rows] = await pool.query(
    `SELECT so.id, so.order_code, so.total_amount, so.discount_total,
            so.payment_type, so.created_at,
            COALESCE(c.CustName,'ลูกค้าทั่วไป') AS cname
     FROM sales_orders so
     LEFT JOIN customer c ON c.CustNo=so.customer_id
     WHERE so.sale_by_line_id=? ORDER BY so.id DESC LIMIT ?`,
    [lineUserId, limit]
  );
  return { success: true, data: rows.map(r => ({
    orderId:  r.id,
    code:     r.order_code,
    total:    parseFloat(r.total_amount),
    discount: parseFloat(r.discount_total),
    payment:  r.payment_type,
    customer: r.cname,
    time:     String(r.created_at)
  }))};
}


// ===================== UTIL =====================
function genCode(prefix) {
  const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
  return `${prefix}-${d}-${Math.floor(1000+Math.random()*9000)}`;
}


// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Van Sales Middleware running on port ${PORT}`));
