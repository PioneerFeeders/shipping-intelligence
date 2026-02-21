const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../utils/logger');
const config = require('../config/env');

// Auth middleware (same as dashboard-api.js)
function requireAuth(req, res, next) {
  const token = req.cookies?.dashboard_token || req.headers['x-dashboard-token'];
  if (token === config.dashboardPassword) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);

// ============================================================
// GET /dashboard/api/payroll/employees
// ============================================================
router.get('/employees', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM payroll_employees WHERE active = true ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'Payroll employees error');
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

// ============================================================
// GET /dashboard/api/payroll/week?date=2026-02-17
// ============================================================
router.get('/week', async (req, res) => {
  try {
    const weekStart = req.query.date;
    if (!weekStart) return res.status(400).json({ error: 'date param required' });

    const { rows: employees } = await db.query(
      'SELECT * FROM payroll_employees WHERE active = true ORDER BY id'
    );

    const { rows: entries } = await db.query(
      'SELECT * FROM payroll_weeks WHERE week_start = $1',
      [weekStart]
    );

    const data = employees.map(emp => {
      const entry = entries.find(e => e.employee_id === emp.id);
      return {
        employee_id: emp.id,
        name: emp.name,
        pay_type: emp.pay_type,
        hourly_rate: emp.hourly_rate ? parseFloat(emp.hourly_rate) : null,
        weekly_fixed: emp.weekly_fixed ? parseFloat(emp.weekly_fixed) : null,
        hours: entry ? parseFloat(entry.hours) : null,
        pay: entry ? parseFloat(entry.pay) : (emp.pay_type === 'fixed' ? parseFloat(emp.weekly_fixed) : null),
        notes: entry ? entry.notes : null,
        saved: !!entry,
      };
    });

    const totalPay = data.reduce((s, d) => s + (d.pay || 0), 0);

    res.json({ week_start: weekStart, employees: data, total_pay: totalPay });
  } catch (err) {
    logger.error({ err }, 'Payroll week error');
    res.status(500).json({ error: 'Failed to load payroll week' });
  }
});

// ============================================================
// POST /dashboard/api/payroll/week
// Body: { week_start: "2026-02-17", entries: [{ employee_id, hours, pay, notes }] }
// ============================================================
router.post('/week', async (req, res) => {
  try {
    const { week_start, entries } = req.body;
    if (!week_start || !entries) return res.status(400).json({ error: 'week_start and entries required' });

    for (const entry of entries) {
      await db.query(`
        INSERT INTO payroll_weeks (week_start, employee_id, hours, pay, notes, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (week_start, employee_id)
        DO UPDATE SET hours = $3, pay = $4, notes = $5, updated_at = NOW()
      `, [week_start, entry.employee_id, entry.hours, entry.pay, entry.notes || null]);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Payroll save error');
    res.status(500).json({ error: 'Failed to save payroll' });
  }
});

// ============================================================
// GET /dashboard/api/payroll/summary?weeks=8
// ============================================================
router.get('/summary', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 8;
    const { rows } = await db.query(`
      SELECT week_start, SUM(pay) as total_pay, COUNT(*) as employee_count
      FROM payroll_weeks
      GROUP BY week_start
      ORDER BY week_start DESC
      LIMIT $1
    `, [weeks]);

    res.json(rows.map(r => ({
      week_start: r.week_start,
      total_pay: parseFloat(r.total_pay),
      employee_count: parseInt(r.employee_count),
    })));
  } catch (err) {
    logger.error({ err }, 'Payroll summary error');
    res.status(500).json({ error: 'Failed to load payroll summary' });
  }
});

// ============================================================
// GET /dashboard/api/payroll/current-total
// ============================================================
router.get('/current-total', async (req, res) => {
  try {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const weekStart = monday.toISOString().split('T')[0];

    const { rows } = await db.query(
      'SELECT COALESCE(SUM(pay), 0) as total FROM payroll_weeks WHERE week_start = $1',
      [weekStart]
    );

    res.json({
      week_start: weekStart,
      total_pay: parseFloat(rows[0].total),
    });
  } catch (err) {
    logger.error({ err }, 'Payroll current total error');
    res.status(500).json({ error: 'Failed to load payroll total' });
  }
});

module.exports = router;
