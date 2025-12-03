const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API proxy endpoints to avoid CORS issues
app.get('/api/config', (req, res) => {
    // Return localhost URLs for browser access
    res.json({
        mmsUrl: 'http://localhost:8000',
        pmsUrl: 'http://localhost:3000'
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'dashboard' });
});

// Serve the dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
    console.log(`Dashboard ready - serving UI on port ${PORT}`);
});
