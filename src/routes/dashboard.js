const express = require('express');
const router = express.Router();
const path = require('path');
const config = require('../config/env');

// Serve dashboard HTML
router.get('/', (req, res) => {
  // Check auth cookie
  const token = req.cookies?.dashboard_token;
  if (token !== config.dashboardPassword) {
    // Serve login page
    return res.send(getLoginPage());
  }
  res.sendFile(path.join(__dirname, '../../public/dashboard.html'));
});

function getLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pioneer Feeders — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: #0a0e17;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: #131a2b;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 48px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 25px 50px rgba(0,0,0,0.4);
    }
    .logo {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 32px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      background: #0a0e17;
      border: 1px solid #1e293b;
      border-radius: 10px;
      color: #e2e8f0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #38bdf8; }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      border: none;
      border-radius: 10px;
      color: #0a0e17;
      font-family: 'DM Sans', sans-serif;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 16px;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .error { color: #f87171; font-size: 13px; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">Pioneer Feeders</div>
    <h1>Operations Dashboard</h1>
    <input type="password" id="pw" placeholder="Enter password" autofocus>
    <button onclick="login()">Sign In</button>
    <div class="error" id="err">Invalid password</div>
  </div>
  <script>
    document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    async function login() {
      const pw = document.getElementById('pw').value;
      const res = await fetch('/dashboard/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        document.getElementById('err').style.display = 'block';
      }
    }
  </script>
</body>
</html>`;
}

module.exports = router;
