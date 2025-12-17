const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const PMS_URL = process.env.PMS_URL || 'http://localhost:3000';
const MMS_URL = process.env.MMS_URL || 'http://localhost:8000';

// Middleware for parsing JSON
app.use(express.json());

// Proxy API requests to PMS
app.use('/api', async (req, res) => {
    try {
        const url = `${PMS_URL}${req.path}`;
        const options = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            options.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, options);
        const data = await response.json();

        res.status(response.status).json(data);
    } catch (error) {
        console.error('API proxy error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to connect to PMS service'
        });
    }
});

// Proxy MMS requests (for sensor health data)
app.use('/mms', async (req, res) => {
    try {
        const url = `${MMS_URL}${req.path}`;
        const options = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            options.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, options);
        const data = await response.json();

        res.status(response.status).json(data);
    } catch (error) {
        console.error('MMS proxy error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to connect to MMS service'
        });
    }
});

// Serve static files
app.use(express.static(__dirname));

// Fallback to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🎨 Dashboard running at http://localhost:${PORT}`);
    console.log(`📡 Proxying PMS requests to ${PMS_URL}`);
    console.log(`📊 Proxying MMS requests to ${MMS_URL}`);
});
